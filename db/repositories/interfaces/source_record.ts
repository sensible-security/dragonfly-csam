import type { ProvenanceEntityType } from "./taxonomy.ts";
import type { AuditContext, Page, PageRequest } from "./common.ts";

// Registry of ingestion origins (PRD Assumption 10). The full Connector
// interface is Phase 3; this is the identity anchor for provenance.
export interface Source {
  id: string;
  // Open set until Phase 3 fixes the connector taxonomy (gate decision 3).
  sourceType: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSource {
  sourceType: string;
  name: string;
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
}
