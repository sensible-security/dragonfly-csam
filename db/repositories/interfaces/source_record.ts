import type { ProvenanceEntityType } from "./taxonomy.ts";
import type { AuditContext, Page, PageRequest } from "./common.ts";
import type { ReconciliationStatus } from "./ingestion.ts";

// Registry of ingestion origins (PRD Assumption 10). The Connector taxonomy is
// pinned in Phase 3; source_type is validated by the connector layer + the SQL
// CHECK (0002). precedence is the field-level source-of-truth rank (PRD §6.3):
// higher wins on conflict. manual 100 > cloud 80 > scanner 50 > csv 40 > dhcp 20.
export interface Source {
  id: string;
  sourceType: string;
  name: string;
  precedence: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSource {
  sourceType: string;
  name: string;
  precedence?: number; // defaults to 50 (schema default) when omitted
}

// Staging store (AGENTS.md §4.2): every normalized observation lands here
// with provenance before reconciliation merges into canonical tables.
export interface SourceRecord {
  id: string;
  sourceId: string;
  externalId: string; // the source's own identifier for the asset
  entityKind: ProvenanceEntityType;
  // Verbatim payload as received. Untrusted DATA — never interpreted.
  rawPayload: string;
  // Canonical-shape JSON produced by the connector's normalize step.
  normalizedPayload: string;
  firstSeen: string;
  lastSeen: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSourceRecord {
  sourceId: string;
  externalId: string;
  entityKind: ProvenanceEntityType;
  rawPayload: string;
  normalizedPayload: string;
  observedAt: string;
}

// Which source currently owns each canonical field's value (AGENTS.md §4.2).
// Value history lives in audit_log diffs, not here.
export interface FieldProvenance {
  id: string;
  entityType: ProvenanceEntityType;
  entityId: string;
  fieldName: string;
  sourceId: string;
  observedAt: string;
}

export interface ISourceRecordRepository {
  registerSource(input: CreateSource, ctx: AuditContext): Promise<Source>;
  getSourceByName(name: string): Promise<Source | null>;
  // Owner-of-a-field lookup for precedence comparison (PRD §6.3).
  getSourceById(id: string): Promise<Source | null>;
  // Keyed (sourceId, externalId): insert sets first_seen; re-observation
  // refreshes last_seen + payloads.
  upsertObservation(
    input: UpsertSourceRecord,
    ctx: AuditContext,
  ): Promise<SourceRecord>;
  getById(id: string): Promise<SourceRecord | null>;
  listBySource(
    sourceId: string,
    page: PageRequest,
  ): Promise<Page<SourceRecord>>;
  findByExternalId(
    sourceId: string,
    externalId: string,
  ): Promise<SourceRecord | null>;
  // Staging-order feed for reconciliation: records from a source still awaiting
  // an outcome (reconciliation_status = 'pending').
  listPendingBySource(sourceId: string): Promise<SourceRecord[]>;
  setFieldProvenance(
    entityType: ProvenanceEntityType,
    entityId: string,
    fieldName: string,
    sourceId: string,
    observedAt: string,
  ): Promise<void>;
  getFieldProvenance(
    entityType: ProvenanceEntityType,
    entityId: string,
  ): Promise<FieldProvenance[]>;
  // Stamps the reconciliation outcome onto a staged record (PRD §8). Nullable
  // match target for pending/rejected/in_review outcomes with no canonical row.
  setReconciliationOutcome(
    recordId: string,
    status: ReconciliationStatus,
    matchedEntityType?: ProvenanceEntityType | null,
    matchedEntityId?: string | null,
  ): Promise<void>;
}
