// Ingestion-batch + quarantine repository (PRD §5, §8). One connector run =
// one batch; malformed rows land in ingestion_errors (never staged). Batch
// open/finalize are audited connector activity (AGENTS.md §4.4); individual
// quarantined rows are summarized by the batch counts, not audited per-row.
import {
  type AuditContext,
  type CreateIngestionError,
  type FinalizeIngestionBatch,
  type IIngestionBatchRepository,
  type IngestionBatch,
  type IngestionError,
  NotFoundError,
  type OpenIngestionBatch,
  type RowIssue,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface BatchRow {
  id: string;
  source_id: string;
  connector_id: string;
  status: IngestionBatch["status"];
  total_rows: number;
  staged_count: number;
  quarantined_count: number;
  actor_type: IngestionBatch["actorType"];
  actor_id: string;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

interface ErrorRow {
  id: string;
  batch_id: string;
  row_ref: string;
  external_id: string | null;
  raw_row: string;
  issues_json: string;
  created_at: string;
}

function toBatch(row: BatchRow): IngestionBatch {
  return {
    id: row.id,
    sourceId: row.source_id,
    connectorId: row.connector_id,
    status: row.status,
    totalRows: row.total_rows,
    stagedCount: row.staged_count,
    quarantinedCount: row.quarantined_count,
    actorType: row.actor_type,
    actorId: row.actor_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function toError(row: ErrorRow): IngestionError {
  return {
    id: row.id,
    batchId: row.batch_id,
    rowRef: row.row_ref,
    externalId: row.external_id,
    rawRow: row.raw_row,
    issues: JSON.parse(row.issues_json) as RowIssue[],
    createdAt: row.created_at,
  };
}

export class TursoIngestionBatchRepository
  implements IIngestionBatchRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async open(
    input: OpenIngestionBatch,
    ctx: AuditContext,
  ): Promise<IngestionBatch> {
    const ts = nowIso();
    const batch: IngestionBatch = {
      id: crypto.randomUUID(),
      sourceId: input.sourceId,
      connectorId: input.connectorId,
      status: "running",
      totalRows: 0,
      stagedCount: 0,
      quarantinedCount: 0,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      startedAt: ts,
      finishedAt: null,
      createdAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO ingestion_batches (
             id, source_id, connector_id, status, total_rows, staged_count,
             quarantined_count, actor_type, actor_id, started_at, finished_at,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        );
        await stmt.run(
          batch.id,
          batch.sourceId,
          batch.connectorId,
          batch.status,
          batch.totalRows,
          batch.stagedCount,
          batch.quarantinedCount,
          batch.actorType,
          batch.actorId,
          batch.startedAt,
          batch.createdAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "ingestion_batch",
          entityId: batch.id,
          afterJson: JSON.stringify({
            sourceId: batch.sourceId,
            connectorId: batch.connectorId,
            startedAt: batch.startedAt,
          }),
        });
        return batch;
      });
    } catch (err) {
      translateConstraintError(err, `batch for source ${input.sourceId}`);
    }
  }

  async finalize(
    id: string,
    counts: FinalizeIngestionBatch,
    ctx: AuditContext,
  ): Promise<IngestionBatch> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("ingestion_batch", id);

    const finishedAt = nowIso();
    const after: IngestionBatch = {
      ...before,
      status: counts.status,
      totalRows: counts.totalRows,
      stagedCount: counts.stagedCount,
      quarantinedCount: counts.quarantinedCount,
      finishedAt,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `UPDATE ingestion_batches SET
             status = ?, total_rows = ?, staged_count = ?,
             quarantined_count = ?, finished_at = ?
           WHERE id = ?`,
        );
        await stmt.run(
          after.status,
          after.totalRows,
          after.stagedCount,
          after.quarantinedCount,
          after.finishedAt,
          id,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "update",
          entityType: "ingestion_batch",
          entityId: id,
          beforeJson: JSON.stringify({ status: before.status }),
          afterJson: JSON.stringify({
            status: after.status,
            totalRows: after.totalRows,
            stagedCount: after.stagedCount,
            quarantinedCount: after.quarantinedCount,
          }),
        });
        return after;
      });
    } catch (err) {
      translateConstraintError(err, `finalize batch ${id}`);
    }
  }

  async getById(id: string): Promise<IngestionBatch | null> {
    const stmt = await this.db.prepare(
      "SELECT * FROM ingestion_batches WHERE id = ?",
    );
    const row = await stmt.get(id) as BatchRow | undefined;
    return row ? toBatch(row) : null;
  }

  async recordError(input: CreateIngestionError): Promise<IngestionError> {
    const error: IngestionError = {
      id: crypto.randomUUID(),
      batchId: input.batchId,
      rowRef: input.rowRef,
      externalId: input.externalId ?? null,
      rawRow: input.rawRow,
      issues: input.issues,
      createdAt: nowIso(),
    };
    try {
      const stmt = await this.db.prepare(
        `INSERT INTO ingestion_errors (
           id, batch_id, row_ref, external_id, raw_row, issues_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      await stmt.run(
        error.id,
        error.batchId,
        error.rowRef,
        error.externalId,
        error.rawRow,
        JSON.stringify(error.issues),
        error.createdAt,
      );
      return error;
    } catch (err) {
      translateConstraintError(
        err,
        `ingestion error for batch ${input.batchId}`,
      );
    }
  }

  async listErrors(batchId: string): Promise<IngestionError[]> {
    const stmt = await this.db.prepare(
      "SELECT * FROM ingestion_errors WHERE batch_id = ? ORDER BY created_at, id",
    );
    const rows = await stmt.all(batchId) as ErrorRow[];
    return rows.map(toError);
  }
}
