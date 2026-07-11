// Source / staging repository (AGENTS.md §4.2). Observations land here with
// full provenance before Phase 3 reconciliation merges them into canonical
// tables. raw_payload is untrusted DATA: bound as a parameter, stored
// verbatim, never parsed or interpreted (AGENTS.md §2.7).
import {
  type AuditContext,
  type CreateSource,
  type FieldProvenance,
  type ISourceRecordRepository,
  NotFoundError,
  type Page,
  type PageRequest,
  type ProvenanceEntityType,
  type ReconciliationStatus,
  type Source,
  type SourceRecord,
  type UpsertSourceRecord,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface SourceRow {
  id: string;
  source_type: string;
  name: string;
  precedence: number;
  created_at: string;
  updated_at: string;
}

interface RecordRow {
  id: string;
  source_id: string;
  external_id: string;
  entity_kind: ProvenanceEntityType;
  raw_payload: string;
  normalized_payload: string;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

interface ProvenanceRow {
  id: string;
  entity_type: ProvenanceEntityType;
  entity_id: string;
  field_name: string;
  source_id: string;
  observed_at: string;
}

function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    sourceType: row.source_type,
    name: row.name,
    precedence: row.precedence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRecord(row: RecordRow): SourceRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    externalId: row.external_id,
    entityKind: row.entity_kind,
    rawPayload: row.raw_payload,
    normalizedPayload: row.normalized_payload,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProvenance(row: ProvenanceRow): FieldProvenance {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fieldName: row.field_name,
    sourceId: row.source_id,
    observedAt: row.observed_at,
  };
}

export class TursoSourceRecordRepository implements ISourceRecordRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async registerSource(
    input: CreateSource,
    ctx: AuditContext,
  ): Promise<Source> {
    const ts = nowIso();
    const source: Source = {
      id: crypto.randomUUID(),
      sourceType: input.sourceType,
      name: input.name,
      precedence: input.precedence ?? 50,
      createdAt: ts,
      updatedAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO sources (id, source_type, name, precedence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          source.id,
          source.sourceType,
          source.name,
          source.precedence,
          source.createdAt,
          source.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "source",
          entityId: source.id,
          afterJson: JSON.stringify(source),
        });
        return source;
      });
    } catch (err) {
      translateConstraintError(err, `source ${source.name}`);
    }
  }

  async getSourceByName(name: string): Promise<Source | null> {
    const stmt = await this.db.prepare("SELECT * FROM sources WHERE name = ?");
    const row = await stmt.get(name) as SourceRow | undefined;
    return row ? toSource(row) : null;
  }

  async getSourceById(id: string): Promise<Source | null> {
    const stmt = await this.db.prepare("SELECT * FROM sources WHERE id = ?");
    const row = await stmt.get(id) as SourceRow | undefined;
    return row ? toSource(row) : null;
  }

  async upsertObservation(
    input: UpsertSourceRecord,
    ctx: AuditContext,
  ): Promise<SourceRecord> {
    const sourceStmt = await this.db.prepare(
      "SELECT id FROM sources WHERE id = ?",
    );
    if (!await sourceStmt.get(input.sourceId)) {
      throw new NotFoundError("source", input.sourceId);
    }

    const existing = await this.findByExternalId(
      input.sourceId,
      input.externalId,
    );
    const ts = nowIso();

    try {
      return await withTransaction(this.db, async () => {
        // Re-observation: refresh last_seen + both payloads on the same row;
        // first_seen is immutable provenance.
        if (existing) {
          const refreshed: SourceRecord = {
            ...existing,
            entityKind: input.entityKind,
            rawPayload: input.rawPayload,
            normalizedPayload: input.normalizedPayload,
            lastSeen: input.observedAt,
            updatedAt: ts,
          };
          // Re-observation re-enters reconciliation: reset the outcome to
          // 'pending' so the refreshed record is picked up again (PRD §6.4).
          const stmt = await this.db.prepare(
            `UPDATE source_records SET
               entity_kind = ?, raw_payload = ?, normalized_payload = ?,
               last_seen = ?, updated_at = ?, reconciliation_status = 'pending'
             WHERE id = ?`,
          );
          await stmt.run(
            refreshed.entityKind,
            refreshed.rawPayload,
            refreshed.normalizedPayload,
            refreshed.lastSeen,
            refreshed.updatedAt,
            existing.id,
          );
          await writeAuditEntry(this.db, {
            ...ctx,
            action: "ingest",
            entityType: "source_record",
            entityId: existing.id,
            beforeJson: JSON.stringify({ lastSeen: existing.lastSeen }),
            afterJson: JSON.stringify({ lastSeen: refreshed.lastSeen }),
          });
          return refreshed;
        }

        const record: SourceRecord = {
          id: crypto.randomUUID(),
          sourceId: input.sourceId,
          externalId: input.externalId,
          entityKind: input.entityKind,
          rawPayload: input.rawPayload,
          normalizedPayload: input.normalizedPayload,
          firstSeen: input.observedAt,
          lastSeen: input.observedAt,
          createdAt: ts,
          updatedAt: ts,
        };
        const stmt = await this.db.prepare(
          `INSERT INTO source_records (
             id, source_id, external_id, entity_kind, raw_payload,
             normalized_payload, first_seen, last_seen, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          record.id,
          record.sourceId,
          record.externalId,
          record.entityKind,
          record.rawPayload,
          record.normalizedPayload,
          record.firstSeen,
          record.lastSeen,
          record.createdAt,
          record.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "ingest",
          entityType: "source_record",
          entityId: record.id,
          afterJson: JSON.stringify({
            sourceId: record.sourceId,
            externalId: record.externalId,
            firstSeen: record.firstSeen,
          }),
        });
        return record;
      });
    } catch (err) {
      translateConstraintError(
        err,
        `observation ${input.externalId} from ${input.sourceId}`,
      );
    }
  }

  async getById(id: string): Promise<SourceRecord | null> {
    const stmt = await this.db.prepare(
      "SELECT * FROM source_records WHERE id = ?",
    );
    const row = await stmt.get(id) as RecordRow | undefined;
    return row ? toRecord(row) : null;
  }

  async listBySource(
    sourceId: string,
    page: PageRequest,
  ): Promise<Page<SourceRecord>> {
    const countStmt = await this.db.prepare(
      "SELECT COUNT(*) AS total FROM source_records WHERE source_id = ?",
    );
    const { total } = await countStmt.get(sourceId) as { total: number };

    const listStmt = await this.db.prepare(
      `SELECT * FROM source_records WHERE source_id = ?
       ORDER BY first_seen, id LIMIT ? OFFSET ?`,
    );
    const rows = await listStmt.all(
      sourceId,
      page.limit,
      page.offset,
    ) as RecordRow[];

    return {
      items: rows.map(toRecord),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async findByExternalId(
    sourceId: string,
    externalId: string,
  ): Promise<SourceRecord | null> {
    const stmt = await this.db.prepare(
      "SELECT * FROM source_records WHERE source_id = ? AND external_id = ?",
    );
    const row = await stmt.get(sourceId, externalId) as RecordRow | undefined;
    return row ? toRecord(row) : null;
  }

  async listPendingBySource(sourceId: string): Promise<SourceRecord[]> {
    const stmt = await this.db.prepare(
      `SELECT * FROM source_records
       WHERE source_id = ? AND reconciliation_status = 'pending'
       ORDER BY first_seen, id`,
    );
    const rows = await stmt.all(sourceId) as RecordRow[];
    return rows.map(toRecord);
  }

  async setFieldProvenance(
    entityType: ProvenanceEntityType,
    entityId: string,
    fieldName: string,
    sourceId: string,
    observedAt: string,
  ): Promise<void> {
    const existingStmt = await this.db.prepare(
      `SELECT id FROM field_provenance
       WHERE entity_type = ? AND entity_id = ? AND field_name = ?`,
    );
    const existing = await existingStmt.get(entityType, entityId, fieldName) as
      | { id: string }
      | undefined;

    try {
      if (existing) {
        const stmt = await this.db.prepare(
          "UPDATE field_provenance SET source_id = ?, observed_at = ? WHERE id = ?",
        );
        await stmt.run(sourceId, observedAt, existing.id);
        return;
      }
      const stmt = await this.db.prepare(
        `INSERT INTO field_provenance (
           id, entity_type, entity_id, field_name, source_id, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      await stmt.run(
        crypto.randomUUID(),
        entityType,
        entityId,
        fieldName,
        sourceId,
        observedAt,
      );
    } catch (err) {
      translateConstraintError(
        err,
        `field provenance ${entityType}/${entityId}/${fieldName}`,
      );
    }
  }

  async getFieldProvenance(
    entityType: ProvenanceEntityType,
    entityId: string,
  ): Promise<FieldProvenance[]> {
    const stmt = await this.db.prepare(
      `SELECT * FROM field_provenance
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY field_name`,
    );
    const rows = await stmt.all(entityType, entityId) as ProvenanceRow[];
    return rows.map(toProvenance);
  }

  // Staging bookkeeping (not itself audited — the merge/create it records
  // writes the audit trail). Stamps outcome + resolved canonical target.
  async setReconciliationOutcome(
    recordId: string,
    status: ReconciliationStatus,
    matchedEntityType: ProvenanceEntityType | null = null,
    matchedEntityId: string | null = null,
  ): Promise<void> {
    const existsStmt = await this.db.prepare(
      "SELECT id FROM source_records WHERE id = ?",
    );
    if (!await existsStmt.get(recordId)) {
      throw new NotFoundError("source_record", recordId);
    }
    const stmt = await this.db.prepare(
      `UPDATE source_records SET
         reconciliation_status = ?, matched_entity_type = ?,
         matched_entity_id = ?, reconciled_at = ?
       WHERE id = ?`,
    );
    await stmt.run(
      status,
      matchedEntityType,
      matchedEntityId,
      nowIso(),
      recordId,
    );
  }
}
