// Append-only audit log repository (AGENTS.md §4.4; PRD §3.3). No update or
// delete exists on this class, by contract and by omission.
import type {
  AuditEntry,
  AuditFilter,
  CreateAuditEntry,
  IAuditLogRepository,
  Page,
  PageRequest,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import { buildWhere, translateConstraintError } from "./helpers.ts";

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_type: AuditEntry["actorType"];
  actor_id: string;
  action: AuditEntry["action"];
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  source_address: string | null;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    beforeJson: row.before_json,
    afterJson: row.after_json,
    sourceAddress: row.source_address,
  };
}

export class TursoAuditLogRepository implements IAuditLogRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async append(entry: CreateAuditEntry): Promise<AuditEntry> {
    try {
      return await writeAuditEntry(this.db, entry);
    } catch (err) {
      translateConstraintError(err, "audit_log append");
    }
  }

  async query(
    filter: AuditFilter,
    page: PageRequest,
  ): Promise<Page<AuditEntry>> {
    const { where, params } = buildWhere([
      ["entity_type = ?", filter.entityType],
      ["entity_id = ?", filter.entityId],
      ["actor_id = ?", filter.actorId],
      ["action = ?", filter.action],
      ["occurred_at > ?", filter.occurredAfter],
      ["occurred_at < ?", filter.occurredBefore],
    ]);

    const countStmt = await this.db.prepare(
      `SELECT COUNT(*) AS total FROM audit_log${where}`,
    );
    const { total } = await countStmt.get(...params) as { total: number };

    const listStmt = await this.db.prepare(
      `SELECT * FROM audit_log${where}
       ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
    );
    const rows = await listStmt.all(
      ...params,
      page.limit,
      page.offset,
    ) as AuditRow[];

    return {
      items: rows.map(toEntry),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }
}
