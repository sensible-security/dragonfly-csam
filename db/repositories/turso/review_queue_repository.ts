// Review-queue repository (PRD §7). Ambiguous matches and new-asset-needing-
// enrichment items land here for a human; nothing is ever auto-resolved
// (AGENTS.md §4.2). Top-level columns (status/kind/reason/confidence) and the
// source-record join filter in SQL; attribute-contains filtering and sort-by-
// projected-attribute run in-repo (the queue is bounded), keeping us off the
// beta driver's JSON functions. resolve() writes a status_change audit entry.
import {
  type AuditContext,
  type CreateReviewItem,
  type IReviewQueueRepository,
  NotFoundError,
  type Page,
  type PageRequest,
  type ResolveReviewItem,
  type ReviewCandidate,
  type ReviewQueueFilter,
  type ReviewQueueItem,
  type ReviewQueueSort,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  buildWhere,
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface QueueRow {
  id: string;
  source_record_id: string;
  entity_kind: ReviewQueueItem["entityKind"];
  reason: ReviewQueueItem["reason"];
  confidence: ReviewQueueItem["confidence"];
  candidates_json: string;
  attributes_json: string;
  status: ReviewQueueItem["status"];
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  source_id: string; // joined from source_records
}

function toItem(row: QueueRow): ReviewQueueItem {
  return {
    id: row.id,
    sourceRecordId: row.source_record_id,
    entityKind: row.entity_kind,
    reason: row.reason,
    confidence: row.confidence,
    candidates: JSON.parse(row.candidates_json) as ReviewCandidate[],
    attributes: JSON.parse(row.attributes_json) as Record<
      string,
      string | null
    >,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

// Confidence has an intrinsic order for sorting; other fields sort lexically.
const CONFIDENCE_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  ambiguous: 1,
};

export class TursoReviewQueueRepository implements IReviewQueueRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async enqueue(
    input: CreateReviewItem,
    ctx: AuditContext,
  ): Promise<ReviewQueueItem> {
    const ts = nowIso();
    const item: ReviewQueueItem = {
      id: crypto.randomUUID(),
      sourceRecordId: input.sourceRecordId,
      entityKind: input.entityKind,
      reason: input.reason,
      confidence: input.confidence,
      candidates: input.candidates,
      attributes: input.attributes,
      status: "pending",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: ts,
    };
    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO review_queue (
             id, source_record_id, entity_kind, reason, confidence,
             candidates_json, attributes_json, status, resolved_by,
             resolved_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
        );
        await stmt.run(
          item.id,
          item.sourceRecordId,
          item.entityKind,
          item.reason,
          item.confidence,
          JSON.stringify(item.candidates),
          JSON.stringify(item.attributes),
          item.createdAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "review_queue_item",
          entityId: item.id,
          afterJson: JSON.stringify({
            sourceRecordId: item.sourceRecordId,
            reason: item.reason,
            confidence: item.confidence,
          }),
        });
        return item;
      });
    } catch (err) {
      translateConstraintError(err, `review item for ${input.sourceRecordId}`);
    }
  }

  async getById(id: string): Promise<ReviewQueueItem | null> {
    const stmt = await this.db.prepare(
      `SELECT rq.*, sr.source_id AS source_id
       FROM review_queue rq
       JOIN source_records sr ON sr.id = rq.source_record_id
       WHERE rq.id = ?`,
    );
    const row = await stmt.get(id) as QueueRow | undefined;
    return row ? toItem(row) : null;
  }

  async list(
    filter: ReviewQueueFilter,
    sort: ReviewQueueSort,
    page: PageRequest,
  ): Promise<Page<ReviewQueueItem>> {
    // Default to the pending queue unless a status is explicitly requested.
    const status = filter.status ?? "pending";
    const { where, params } = buildWhere([
      ["rq.status = ?", status],
      ["rq.entity_kind = ?", filter.entityKind],
      ["rq.reason = ?", filter.reason],
      ["rq.confidence = ?", filter.confidence],
      ["sr.source_id = ?", filter.sourceId],
    ]);

    const stmt = await this.db.prepare(
      `SELECT rq.*, sr.source_id AS source_id
       FROM review_queue rq
       JOIN source_records sr ON sr.id = rq.source_record_id${where}`,
    );
    const rows = await stmt.all(...params) as QueueRow[];
    let items = rows.map(toItem);

    // Attribute-contains filter (projected observation fields).
    if (filter.attributeContains) {
      const { field, value } = filter.attributeContains;
      const needle = value.toLowerCase();
      items = items.filter((it) => {
        const v = it.attributes[field];
        return typeof v === "string" && v.toLowerCase().includes(needle);
      });
    }

    // Sort by a top-level column or a projected attribute.
    const dir = sort.dir === "desc" ? -1 : 1;
    const keyOf = (it: ReviewQueueItem): string | number => {
      switch (sort.by) {
        case "createdAt":
          return it.createdAt;
        case "confidence":
          return CONFIDENCE_ORDER[it.confidence] ?? 0;
        case "reason":
          return it.reason;
        case "entityKind":
          return it.entityKind;
        case "status":
          return it.status;
        default:
          return it.attributes[sort.by] ?? "";
      }
    };
    items.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      // Stable tiebreak so pagination is deterministic.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const total = items.length;
    const paged = items.slice(page.offset, page.offset + page.limit);
    return { items: paged, total, limit: page.limit, offset: page.offset };
  }

  async resolve(
    id: string,
    resolution: ResolveReviewItem,
    ctx: AuditContext,
  ): Promise<ReviewQueueItem> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("review_queue_item", id);

    const resolvedAt = nowIso();
    const after: ReviewQueueItem = {
      ...before,
      status: resolution.status,
      resolvedBy: resolution.resolvedBy,
      resolvedAt,
    };
    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `UPDATE review_queue SET status = ?, resolved_by = ?, resolved_at = ?
           WHERE id = ?`,
        );
        await stmt.run(after.status, after.resolvedBy, after.resolvedAt, id);
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "status_change",
          entityType: "review_queue_item",
          entityId: id,
          beforeJson: JSON.stringify({ status: before.status }),
          afterJson: JSON.stringify({
            status: after.status,
            resolvedBy: after.resolvedBy,
          }),
        });
        return after;
      });
    } catch (err) {
      translateConstraintError(err, `resolve review item ${id}`);
    }
  }
}
