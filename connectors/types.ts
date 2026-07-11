// Connector framework contracts (PRD-ingestion-pipeline §3–§4). The connector
// layer is PURE: it produces raw records and normalizes each to a canonical
// Observation (or a RowError). It never touches the database or a service —
// IngestionService owns staging, ReconciliationService owns merge/queue
// (AGENTS.md §4.1/§4.2; enforced by the architecture-boundary test, which
// scans this directory for driver/SQL imports).
import type {
  CreateDevice,
  CreateSoftware,
  MatchKeyName,
  RowIssue,
  SourceType,
} from "../db/repositories/interfaces/mod.ts";

export type { MatchKeyName, RowIssue, SourceType };

// ---------------------------------------------------------------------------
// Canonical observation shapes — the connector-neutral currency of the pipeline.
// Every normalize() emits one of these (or a RowError); everything downstream
// speaks only these shapes.
// ---------------------------------------------------------------------------

// The mutable canonical field sets a source may know, all optional here (a
// source supplies what it has). Match-key identity fields travel in matchKeys.
export type DeviceFields = Partial<CreateDevice>;
export type SoftwareFields = Partial<CreateSoftware>;

export interface DeviceMatchKeys {
  cloudInstanceId?: string; // strongest (globally unique)
  hardwareSerial?: string;
  macAddresses?: string[]; // normalized uppercase colon-separated
  hostname?: string;
  domain?: string; // pairs with hostname (weakest key)
}

export interface ObservedInterface {
  macAddress: string;
  interfaceName?: string | null;
  ips?: { address: string; observedAt: string }[];
}

export interface DeviceObservation {
  kind: "device";
  externalId: string; // the source's stable id (→ source_records.external_id)
  observedAt: string; // ISO-8601 UTC; drives first/last_seen
  matchKeys: DeviceMatchKeys;
  fields: DeviceFields;
  interfaces?: ObservedInterface[];
}

export interface SoftwareObservation {
  kind: "software";
  externalId: string;
  observedAt: string;
  identity: { title: string; publisher: string; version: string }; // exact key
  fields: SoftwareFields;
  installedOnExternalId?: string; // device externalId within the same batch
}

export type Observation = DeviceObservation | SoftwareObservation;

// ---------------------------------------------------------------------------
// The Connector interface + supporting types.
// ---------------------------------------------------------------------------

export interface ConnectorCapabilities {
  mode: "push" | "pull";
  entityKinds: ("device" | "software")[];
  matchKeys: MatchKeyName[];
  providesRequiredFields: boolean; // true ⇒ no-match may auto-create (PRD A1)
  incremental: boolean; // last_seen-delta fetch (pull only)
}

export interface RawRecord {
  externalId: string;
  payload: string; // verbatim as received (one CSV row / one JSON object) — DATA
  rowRef?: string | number; // row index, for the error report
}

export interface RowError {
  rowRef: string | number;
  externalId?: string;
  issues: RowIssue[]; // Zod-derived; safe, never echoes payload as instruction
}

// Discriminated result of normalizing ONE raw record — normalize never throws.
export type NormalizationResult =
  | { ok: true; observation: Observation }
  | { ok: false; error: RowError };

export interface ConnectorContext {
  sourceId: string; // resolved sources.id for this run
  observedAt: string; // batch clock (ISO-8601 UTC)
  options?: Record<string, unknown>; // e.g. CSV column-mapping
}

export interface Connector {
  readonly id: string; // stable connector instance id (1:1 with a sources row)
  readonly sourceType: SourceType;
  readonly capabilities: ConnectorCapabilities;

  // Push connectors implement receive(); pull connectors implement fetch().
  receive?(
    payload: unknown,
    ctx: ConnectorContext,
  ): RawRecord[] | Promise<RawRecord[]>;
  fetch?(ctx: ConnectorContext): Promise<RawRecord[]>;

  // Pure, per-record, total (returns RowError instead of throwing). No I/O.
  normalize(raw: RawRecord): NormalizationResult;
}
