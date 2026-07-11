// Internal audit write helper (PLAN decision 2): every mutating repository
// method calls this on its own connection, inside its open transaction, so
// the audit entry commits or rolls back atomically with the data change.
// TursoAuditLogRepository.append wraps the same helper.
import type { AuditEntry, CreateAuditEntry } from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { nowIso } from "./helpers.ts";

export async function writeAuditEntry(
  db: DatabaseConnection,
  entry: CreateAuditEntry,
): Promise<AuditEntry> {
  const full: AuditEntry = {
    id: crypto.randomUUID(),
    occurredAt: entry.occurredAt ?? nowIso(),
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    beforeJson: entry.beforeJson ?? null,
    afterJson: entry.afterJson ?? null,
    sourceAddress: entry.sourceAddress ?? null,
  };
  const stmt = await db.prepare(
    `INSERT INTO audit_log (
       id, occurred_at, actor_type, actor_id, action,
       entity_type, entity_id, before_json, after_json, source_address
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await stmt.run(
    full.id,
    full.occurredAt,
    full.actorType,
    full.actorId,
    full.action,
    full.entityType,
    full.entityId,
    full.beforeJson,
    full.afterJson,
    full.sourceAddress,
  );
  return full;
}
