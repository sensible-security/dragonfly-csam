# PRD: Dragonfly CSAM — Ingestion Pipeline (Connectors & Reconciliation)

**Status:** APPROVED — gate questions resolved 2026-07-11 (see §12)
**Source prompt:** DEVELOPMENT_PLAN.md, Prompt 3.1
**Compliance scope:** CIS Controls v8.1 Safeguards 1.3, 1.4 (design-for), 1.5, 2.4 · builds on 1.1, 1.2, 2.1–2.3 · NIST CSF 2.0 ID.AM-01, -02
**Authority:** AGENTS.md §4.2 (connector/ingestion framework — first-class), §2.7 (untrusted data), §4.4 (audit), §8 (boundaries)
**Builds on:** [PRD-core-data-model.md](./PRD-core-data-model.md) (APPROVED) — the staging (`source_records`), `sources`, and `field_provenance` stores this pipeline fills already exist and ship in `0001_initial.sql`.

---

## Assumptions I'm Making

These are decisions the source materials leave open. Correct any before approving; each is otherwise proceeded with as written. The three that most affect the architecture (1, 2, 4) are re-surfaced as explicit gate questions in §12.

1. **A "new asset" outcome from an automated source does not silently create a canonical row.** `criticality` and `business_impact` are NOT NULL on both `devices` and `software` (ID.AM-05; enforced by SQL + `MissingCriticalityError`). Scanners and DHCP logs cannot supply them and the CIS taxonomy has no "unknown" criticality. Therefore: a no-match observation is **auto-created only when its connector declares `providesRequiredFields: true`** (manual entry; CSV when the required columns are mapped). Otherwise the no-match becomes a **`new_asset` review-queue item** that a human enriches (supplies criticality/business_impact) before promotion. This turns "an unknown device appeared on the network" into an explicit review action — which is precisely the Safeguard 1.3/1.4 workflow — rather than a schema violation. New rows are always created with `status = 'pending_review'` (device) / `authorization_status = 'unauthorized'` (software), never authorized.
2. **Field-level source-of-truth precedence is: manual override wins, then source precedence rank, then recency.** Each source carries an integer `precedence` (added to `sources` in migration 0002). On a merge, an incoming field value overwrites the canonical value only if the incoming source's precedence rank is **higher than** the rank of the source that currently owns that field (per `field_provenance`); equal rank breaks to the more recent `observed_at` (last-writer-wins); lower rank never overwrites but still refreshes `last_seen`. Default rank order (high→low): `manual` (100) > future cloud/authoritative APIs (80) > `scanner_json` (50) > `csv_import` (40) > `dhcp_log` (20). Rationale: a human who typed a value should not be overwritten by a scanner guess; automated sources are trusted in rough proportion to their authority over the fact.
3. **Reconciliation runs synchronously at the end of each ingestion batch**, in-process, one source record at a time in staging order. No queue/worker infrastructure in Phase 3 (async reconciliation is a roadmap scaling concern, not a correctness one). The batch API call returns only after reconciliation completes, so callers get the full outcome summary.
4. **Malformed rows are quarantined in a dedicated store (`ingestion_errors`), separate from the human-review queue.** The two failure modes are different in kind: **quarantine** = the row is structurally invalid (bad JSON/CSV shape, out-of-enum value, missing a usable match key) and never reaches staging; **review** = the row is valid and staged but reconciliation is *ambiguous* or is a *new-asset needing enrichment*. Quarantined rows carry per-row error detail for the downloadable CSV error report and are never partially guessed (AGENTS.md §8).
5. **Reconciliation never infers removal from absence.** An asset or install missing from a later full scan is **not** auto-uninstalled/decommissioned in Phase 3. `last_seen` ages naturally; acting on staleness (auto-decommission after N days, uninstall-on-absence) is a roadmap item requiring an explicit policy. Uninstall/decommission happen only on an explicit signal or a human action.
6. **A batch draws from exactly one source.** Every raw record in a batch shares one `source_id` (one connector run = one batch). Cross-source correlation happens *only* through reconciliation against canonical assets, never within a batch.
7. **Software installations link within a batch by the host device's `externalId`.** A `software` observation names the `externalId` of the device it is installed on (same source). Reconciliation resolves the device first, then the software identity, then upserts the `device_software` row via `ISoftwareRepository.recordInstallation`. If the host device cannot be resolved (queued/quarantined), the installation is deferred to the same review-queue item, not dropped.
8. **`sources.source_type` gets its CHECK constraint now, via a table-rebuild in migration 0002** (SQLite cannot `ALTER TABLE ADD CONSTRAINT`; the standard 12-step rebuild is used). Gate decision 3 of the core PRD explicitly deferred this CHECK to "the connector-framework spec … by additive migration." There is no shipped production data, so the rebuild is safe. Enum: `manual | csv_import | scanner_json | dhcp_log`.
9. **The manual and CSV connectors run in-process (no HTTP auth); only push endpoints under `routes/api/ingest/` are authenticated.** Manual entry is a UI/API action already behind the app's (Phase 5) session auth; CSV upload likewise. The scanner JSON endpoint is machine-to-machine and needs API-key auth — stubbed in Phase 3 (env-configured key → source mapping), replaced by real API-key roles in Phase 5 (Prompt 5.1). The audit actor for ingest is `actor_type = 'connector'`, `actor_id = <source name>`.
10. **Connectors are pure normalizers plus capability descriptors; they never touch the database.** Per AGENTS.md §4.1/§4.2 ("connectors call services, never DB directly … never write a connector that inserts directly into inventory tables"), a `Connector` produces raw records (`fetch`/`receive`) and maps each to a canonical observation (`normalize`) — nothing more. **`IngestionService` owns all staging and calls repositories; `ReconciliationService` owns all merge/queue writes.** This keeps the entire connector directory free of SQL/driver imports, enforced by the existing architecture-boundary test.

---

## 1. Objective

Turn Dragonfly from a hand-entered database into an ingestion platform: a single pipeline — **Source → Normalize → Stage → Reconcile → Merge → Inventory** — that every current and future data source flows through, correlating many noisy observations into one authoritative, provenance-tracked inventory without ever bypassing the Repository Pattern or the audit log.

**Users:** security analysts resolving reconciliation ambiguities and enriching newly-discovered assets; IT integrators pointing scanners/DHCP/cloud sources at the ingest API; the manual entry and CSV import paths analysts use daily.

**Success looks like:** three working connectors (manual, CSV, scanner JSON) built on one `Connector` abstraction; a reconciliation engine whose match-key order, confidence outcomes, and field precedence are specified precisely enough to unit-test; the Phase 3 gate scenario (50-device CSV + overlapping scanner JSON reconciles duplicates and queues one deliberate ambiguity) passes; a fourth connector (DHCP) is describable as pure configuration of the same interface.

### Non-goals (this spec)

- **Real authentication/authorization** → Phase 5 (Prompt 5.1). Phase 3 uses an API-key *stub* for ingest endpoints.
- **UI for the review queue / CSV column-mapper / error report** → Phase 4 (Prompts 4.1–4.3). This spec defines the JSON API and service behavior those islands will drive; it renders no pages.
- **Connectors #4+ (DHCP, Entra, Azure, Intune, AWS, Google, scanners-with-vendor-schemas)** → roadmap. DHCP (§10) is designed-for here to prove the abstraction; it is not built.
- **Async/queued reconciliation, reconciliation-by-absence, auto-decommission** → roadmap (Assumptions 3, 5).
- **Editing `0001_initial.sql`** — forbidden (AGENTS.md §8). All schema change is the additive `0002_ingestion.sql`.

---

## 2. Pipeline Model

```
                        ┌─────────────────────────── Connector (pure) ───────────────────────────┐
 external source ──►    │  fetch()/receive()  ─►  raw records  ─►  normalize()  ─►  Observation |  │
                        │                                                          RowError        │
                        └────────────────────────────────┬──────────────────────────────────────┘
                                                          │  (no DB access)
                        ┌───────────────── IngestionService (Normalize→Stage) ───────────────────┐
   RowError ──────────► │  quarantine → ingestion_errors        Observation → upsert source_record │
                        └────────────────────────────────┬──────────────────────────────────────┘
                                                          │
                        ┌──────────────── ReconciliationService (Reconcile→Merge) ────────────────┐
                        │  match keys → outcome:  auto_merge  |  review_queue  |  new_asset         │
                        │  merge: field precedence → update canonical + field_provenance + audit    │
                        └────────────────────────────────┬──────────────────────────────────────┘
                                                          ▼
                                          canonical Inventory (devices / software / installs)
```

**Stage-by-stage responsibilities:**

| Stage | Owner | What happens | Store touched |
|---|---|---|---|
| Source | `Connector.fetch`/`receive` | Obtain raw records (pull) or accept a delivered payload (push). No interpretation. | none |
| Normalize | `Connector.normalize` | Per-record: raw → canonical `Observation`, or a `RowError`. Zod-validated. Pure, no side effects. | none |
| Stage | `IngestionService` | Valid observations → `ISourceRecordRepository.upsertObservation` (verbatim `raw_payload` + `normalized_payload`, provenance). Invalid → `ingestion_errors`. Opens/closes an `ingestion_batches` row. | source_records, ingestion_batches, ingestion_errors |
| Reconcile | `ReconciliationService` | Per staged record: resolve match keys → confidence outcome. | reads devices/software; writes review_queue |
| Merge | `ReconciliationService` | Apply field precedence; create/update canonical asset; set `field_provenance`; refresh `last_seen`/IP history; **write audit entries** (`create`/`update`/`merge`/`status_change`). | devices, software, device_software, network_interfaces, ip_assignments, field_provenance, audit_log |
| Inventory | (canonical tables) | The authoritative, provenance-tracked result queried by Phase 4 API/UI. | — |

Every write in Stage/Reconcile/Merge goes through the **repository interfaces** with an `AuditContext` (§Core PRD 3.3–3.4), so audit atomicity is inherited for free — no new audit machinery.

---

## 3. Canonical Observation Shapes

The connector-neutral currency of the pipeline. Every `normalize()` emits one of these (or a `RowError`); everything downstream speaks only these shapes. Defined as Zod schemas in `connectors/schemas.ts` (build is Prompt 3.2); the TypeScript contracts:

```ts
// connectors/types.ts — the canonical observation currency
export type Observation = DeviceObservation | SoftwareObservation;

export interface DeviceObservation {
  kind: "device";
  externalId: string;            // the source's stable id for this asset (→ source_records.external_id)
  observedAt: string;            // ISO-8601 UTC; drives first/last_seen
  matchKeys: DeviceMatchKeys;    // the identifiers reconciliation will correlate on
  fields: Partial<DeviceFields>; // canonical device attributes this source knows (camelCase; CreateDevice-shaped subset)
  interfaces?: ObservedInterface[]; // MACs + observed IPs (Safeguard 1.1 history)
}

export interface DeviceMatchKeys {
  cloudInstanceId?: string;      // strongest
  hardwareSerial?: string;
  macAddresses?: string[];       // normalized uppercase colon-separated
  hostname?: string;
  domain?: string;               // pairs with hostname (weakest key)
}

export interface ObservedInterface {
  macAddress: string;
  interfaceName?: string | null;
  ips?: { address: string; observedAt: string }[];
}

export interface SoftwareObservation {
  kind: "software";
  externalId: string;
  observedAt: string;
  identity: { title: string; publisher: string; version: string }; // the software match key (exact)
  fields: Partial<SoftwareFields>;
  installedOnExternalId?: string; // device externalId within the same batch (Assumption 7)
}
```

`DeviceFields`/`SoftwareFields` are the `CreateDevice`/`CreateSoftware` mutable field sets (minus id/timestamps) from the core interfaces, all optional here — a source supplies what it knows. **Untrusted-data rule (AGENTS.md §2.7):** free-text fields (`notes`, `businessImpact`, `businessPurpose`) and the verbatim `rawPayload` are stored as data and never interpreted; normalization strips control characters and enforces length bounds but never executes or trusts payload content.

---

## 4. The Connector Interface

```ts
// connectors/types.ts
export type SourceType = "manual" | "csv_import" | "scanner_json" | "dhcp_log";
export type MatchKeyName =
  | "cloud_instance_id" | "hardware_serial" | "mac_address"
  | "hostname_domain" | "software_identity";

export interface ConnectorCapabilities {
  mode: "push" | "pull";
  entityKinds: ("device" | "software")[];
  matchKeys: MatchKeyName[];        // which keys this source can contribute
  providesRequiredFields: boolean;  // true ⇒ no-match may auto-create; false ⇒ no-match → review (Assumption 1)
  incremental: boolean;             // supports last_seen-delta fetch (pull only)
}

export interface RawRecord {
  externalId: string;
  payload: string;                  // verbatim as received (one CSV row, one JSON object) — untrusted DATA
  rowRef?: string | number;         // row number / index, for the error report
}

// Discriminated result of normalizing ONE raw record — never throws on bad data.
export type NormalizationResult =
  | { ok: true; observation: Observation }
  | { ok: false; error: RowError };

export interface RowError {
  rowRef: string | number;
  externalId?: string;
  issues: { field: string; code: string; message: string }[]; // Zod-derived; safe, no payload echoed as instruction
}

export interface Connector {
  readonly id: string;               // stable connector *instance* id (maps 1:1 to a sources row)
  readonly sourceType: SourceType;
  readonly capabilities: ConnectorCapabilities;

  // Push connectors implement receive(); pull connectors implement fetch().
  receive?(payload: unknown, ctx: ConnectorContext): RawRecord[] | Promise<RawRecord[]>;
  fetch?(ctx: ConnectorContext): Promise<RawRecord[]>;

  // Pure, per-record, total (returns RowError instead of throwing). No I/O, no DB.
  normalize(raw: RawRecord): NormalizationResult;
}

export interface ConnectorContext {
  sourceId: string;         // resolved sources.id for this run
  observedAt: string;       // batch clock (ISO-8601 UTC)
  options?: Record<string, unknown>; // e.g. CSV column-mapping
}
```

**Registry.** `connectors/registry.ts` holds a `ConnectorRegistry` mapping `sourceType` → `Connector`. `IngestionService` resolves the connector from the registry; push routes look it up by the `{sourceType}` path segment. A new connector = register one object; no service edits (open/closed).

---

## 5. IngestionService (Normalize → Stage)

`services/ingestion_service.ts`. Depends only on repository **interfaces** + the registry (no driver).

```ts
export interface IngestionService {
  // One connector run = one batch. Gathers raw (fetch/receive), normalizes each,
  // stages valid observations, quarantines invalid rows, then triggers reconciliation.
  ingest(input: IngestRequest, ctx: AuditContext): Promise<IngestionBatchResult>;
}

export interface IngestRequest {
  sourceType: SourceType;
  sourceName: string;             // resolves/creates the sources row (registerSource)
  payload?: unknown;              // push connectors
  options?: Record<string, unknown>; // e.g. { columnMapping } for CSV
}

export interface IngestionBatchResult {
  batchId: string;
  received: number;
  staged: number;
  quarantined: RowError[];        // downloadable error report source (CSV)
  reconciliation: ReconciliationSummary; // { autoMerged, queuedForReview, created }
}
```

**Algorithm:** resolve/register source → open `ingestion_batches` row → gather raw records → for each: `normalize()`; on `ok:false` write an `ingestion_errors` row (do **not** stage — Assumption 4); on `ok:true` `upsertObservation` into `source_records` (verbatim raw + normalized payloads, provenance, `first/last_seen` per §Core PRD) → close batch counts → hand staged record ids to `ReconciliationService.reconcileBatch(batchId, ctx)` → assemble result. Each staged upsert writes an `ingest` audit entry (inherited from `ISourceRecordRepository`).

---

## 6. Reconciliation Engine (Reconcile → Merge)

`services/reconciliation_service.ts`. The product's heart.

### 6.1 Ordered match keys (AGENTS.md §4.2 — do not reorder without approval)

Devices, strongest → weakest:

| Order | Key | Strength | Single-match behavior |
|---|---|---|---|
| 1 | `cloud_instance_id` | **strong** (globally unique) | auto-merge |
| 2 | `hardware_serial` | **strong** | auto-merge |
| 3 | `mac_address` (any of the observation's MACs) | **weak** (cloned VMs, MAC randomization) | auto-merge **only if corroborated**, else review |
| 4 | `hostname` + `domain` | **weak** (reused, renamed) | auto-merge only if corroborated, else review |

Software: a single **exact** key — `(title, publisher, version)` (already UNIQUE in schema). Match → merge; no match → new/review per Assumption 1.

### 6.2 Confidence outcomes

For each staged device record, walk keys 1→4 and stop at the first key present on the observation that matches ≥1 canonical device:

- **Unique match on a strong key (1–2):** `auto_merge`.
- **Unique match on a weak key (3–4), corroborated:** `auto_merge`. *Corroborated* = the observation carries no field that **conflicts** with the candidate. A conflict = both sides have a non-empty value for a distinguishing field (`hostname`, `hardwareSerial`, `cloudInstanceId`) and they differ.
- **Unique match on a weak key, but a distinguishing field conflicts:** `review_queue` (this is the gate case — matched by MAC, hostname differs → **never auto-merge**).
- **Multiple canonical candidates match** (any key): `review_queue` (ambiguous — the engine will not pick).
- **No key matches any candidate:** `new_asset` → auto-create iff `capabilities.providesRequiredFields`, else `review_queue` as a `new_asset` item (Assumption 1).

A confidence score (`high` / `medium` / `ambiguous`) is recorded on the review item for the UI, derived from the table above; the *outcome* (not the raw score) drives behavior.

### 6.3 Merge with field-level precedence (Assumption 2)

On `auto_merge` (or a human "merge" resolution), for each field the observation provides:

1. If the field's current owner is a manual override → keep canonical (manual wins).
2. Else compare incoming source `precedence` vs the current owner's (`field_provenance.source_id`): **higher** overwrites; **equal** → newer `observed_at` wins; **lower** → keep value, only refresh `last_seen`.
3. On overwrite: update the canonical field via the repository (`update`/`setStatus`/`setAuthorizationStatus`), write `field_provenance(entityType, entityId, fieldName, sourceId, observedAt)`, and let the repository write the `update`/`status_change` audit diff. Status/authorization transitions **always** route through the dedicated audited setters, never a bulk update.

The merge itself writes one `merge` audit entry (action already in the enum) linking the source record to the canonical asset, in addition to the per-field `update` diffs. Interfaces/IPs from the observation flow through `addInterface` / `recordIpObservation` (append-only IP history; `last_seen` refresh semantics inherited from the core repositories).

### 6.4 last_seen refresh semantics (Assumption 5)

- **Staging:** re-observation refreshes `source_records.last_seen` + payloads, `first_seen` unchanged (existing `upsertObservation`).
- **Field provenance:** a provided field refreshes its `observed_at` even when the value is unchanged ("source X still confirms this at T").
- **IP history:** same current IP → refresh `ip_assignments.last_seen`; changed IP → append a row (existing `recordIpObservation`).
- **Canonical `updated_at`:** bumps only when a value actually changes — a confirming re-scan is not an audit-worthy "update".
- **Absence:** never triggers uninstall/decommission (Assumption 5).

### 6.5 Service contract

```ts
export interface ReconciliationService {
  reconcileBatch(batchId: string, ctx: AuditContext): Promise<ReconciliationSummary>;
}
export interface ReconciliationSummary {
  autoMerged: number;
  queuedForReview: number;
  created: number;
}
```

---

## 7. Review Queue

Ambiguous matches and new-asset-needing-enrichment items land here for a human (never auto-resolved — AGENTS.md §4.2).

```ts
// services/review_service.ts
export interface ReviewService {
  // Sortable/filterable listing (gate decision 1) — the queue is worked in bulk.
  list(filter: ReviewFilter, sort: ReviewSort, page: PageRequest): Promise<Page<ReviewItem>>;
  // Human resolutions — each writes audit entries and closes the item.
  merge(itemId: string, targetEntityId: string, ctx: AuditContext): Promise<void>;  // confirm a candidate
  createNew(itemId: string, enrichment: RequiredFields, ctx: AuditContext): Promise<void>; // promote w/ criticality+business_impact
  reject(itemId: string, reason: string, ctx: AuditContext): Promise<void>;         // not our asset / duplicate noise
  // Bulk enrichment (gate decision 1): promote many new_asset items at once,
  // applying the SAME criticality (+ business_impact) to each. Per-item outcome
  // returned so partial failures (e.g. an item no longer pending) surface.
  bulkCreateNew(itemIds: string[], enrichment: RequiredFields, ctx: AuditContext): Promise<BulkResult>;
}

export interface ReviewItem {
  id: string;
  sourceRecordId: string;
  entityKind: "device" | "software";
  reason: "ambiguous_match" | "conflicting_field" | "new_asset";
  confidence: "high" | "medium" | "ambiguous";
  candidates: { entityId: string; matchedKey: MatchKeyName; score: number; conflicts: string[] }[];
  // Projected observation attributes for sort/filter/scan without opening each
  // item (from the staged normalized_payload): hostname/title, source, type, etc.
  attributes: Record<string, string | null>;
  status: "pending" | "merged" | "rejected" | "created_new";
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface ReviewFilter {
  status?: "pending" | "merged" | "rejected" | "created_new"; // defaults to pending
  entityKind?: "device" | "software";
  reason?: "ambiguous_match" | "conflicting_field" | "new_asset";
  confidence?: "high" | "medium" | "ambiguous";
  sourceId?: string;
  attributeContains?: { field: string; value: string }; // e.g. hostname contains "web"
}

export interface ReviewSort {
  // Sort by any projected attribute or a top-level column (createdAt, confidence, …).
  by: string;
  dir: "asc" | "desc";
}

export interface BulkResult {
  succeeded: string[];
  failed: { itemId: string; code: string; message: string }[];
}
```

Resolution actor is `actor_type = 'user'`. `createNew`/`bulkCreateNew` require the enrichment fields (criticality + business_impact) the source couldn't supply and create each asset `pending_review`/`unauthorized`. **Bulk workflow (gate decision 1):** an analyst filters the queue (e.g. `new_asset` devices from one scanner), sorts by a shared attribute (department, subnet, OS), multi-selects the rows that share a business criticality, and applies one criticality + business_impact to all of them in a single audited action — each promoted asset still gets its own `create` audit entry. This is the efficiency path for draining a queue full of newly-discovered devices.

---

## 8. Schema Additions — `db/migrations/0002_ingestion.sql` (additive, forward-only)

1. **`sources`:** add `precedence INTEGER NOT NULL DEFAULT 50` (Assumption 2, `ALTER TABLE ADD COLUMN`). Rebuild the table (12-step) to add `CHECK (source_type IN ('manual','csv_import','scanner_json','dhcp_log'))` (Assumption 8, gate decision 3 of core PRD).
2. **`source_records`:** add reconciliation linkage —
   - `reconciliation_status TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('pending','auto_merged','in_review','created','rejected'))`
   - `matched_entity_type TEXT CHECK (matched_entity_type IN ('device','software'))`, `matched_entity_id TEXT`, `reconciled_at TEXT` (all nullable).
   - index `source_records(reconciliation_status)`.
3. **`ingestion_batches`:** `id` PK, `source_id` FK, `connector_id`, `started_at`, `finished_at`, `status` (`running|completed|failed`), `total_rows`, `staged_count`, `quarantined_count`, `actor_type`, `actor_id`, `created_at`.
4. **`ingestion_errors`:** `id` PK, `batch_id` FK, `row_ref`, `external_id` (nullable), `raw_row` (verbatim), `issues_json`, `created_at`. Powers the downloadable CSV error report.
5. **`review_queue`:** `id` PK, `source_record_id` FK, `entity_kind` CHECK(`device|software`), `reason` CHECK(`ambiguous_match|conflicting_field|new_asset`), `confidence` CHECK(`high|medium|ambiguous`), `candidates_json`, `status` CHECK(`pending|merged|rejected|created_new`) DEFAULT `pending`, `resolved_by`, `resolved_at`, `created_at`; index on `(status)`.

New enums (`reconciliation_status`, `batch status`, review `reason`/`confidence`/`status`, the fixed `source_type`) are added as `as const` arrays in `connectors/` or `db/repositories/interfaces/` and CHECK-parity-tested exactly like the §Core PRD enums.

**Repository surface:** these tables are reached through **new repository interfaces** (`IIngestionBatchRepository`, `IReviewQueueRepository`) added under `db/repositories/interfaces/` with Turso implementations under `db/repositories/turso/`, and new `reconciliation`-linkage methods on `ISourceRecordRepository` (`setReconciliationOutcome(recordId, status, matchedEntityType?, matchedEntityId?)`). No service or connector touches SQL — the boundary test still holds.

---

## 9. The Three Connectors

### 9.1 Manual entry (`manual`) — UI/API-driven
- **Mode** push; **entityKinds** device+software; **matchKeys** all; **providesRequiredFields** `true`; **incremental** false.
- One form submission / API call = one `RawRecord`. `normalize` maps the already-structured input to an `Observation`; a manual entry is authoritative → source `precedence = 100` and every field it sets is recorded as a **manual override** in `field_provenance` (immune to automated overwrite, §6.3).
- Because required fields are present, a no-match creates the canonical asset directly (still `pending_review`/`unauthorized` — a human sets authorized explicitly via the Safeguard 1.2 setter).

### 9.2 CSV bulk import (`csv_import`) — with column mapping + error report
- **Mode** push; **entityKinds** device+software; **matchKeys** serial/MAC/hostname+domain; **providesRequiredFields** `true` *iff* criticality + business_impact columns are mapped, else `false` (no-match rows → review for enrichment); **incremental** false.
- `options.columnMapping` maps spreadsheet headers → canonical fields. `receive` splits the upload into one `RawRecord` per data row (`rowRef` = line number). `normalize` applies the mapping + Zod: unmapped-but-required, bad enum, unparseable value → `RowError` (quarantined). Valid rows stage + reconcile.
- **Downloadable error report:** `IngestionBatchResult.quarantined` (backed by `ingestion_errors`) renders/exports as a CSV of `row, column, value, error` — Phase 4 UI; the data contract is defined here.
- Fixtures (Prompt 3.2 build): `tests/fixtures/` gets a clean 50-row device CSV and a companion with deliberately malformed rows (bad criticality enum, missing hostname, duplicate serial).

### 9.3 Scanner JSON ingest (`scanner_json`) — Safeguards 1.3, 1.5, 2.4
- **Mode** push; **entityKinds** device+software; **matchKeys** cloud instance id/serial/MAC/hostname; **providesRequiredFields** `false` (scanners don't know business criticality → no-match → review); **incremental** false.
- **Endpoint:** `POST /routes/api/ingest/scanner_json` (generic authenticated JSON ingest). **Auth:** `Authorization: Bearer <api-key>` / `X-API-Key` header → env-configured key mapping to a `sources` row and a `connector` actor (**stub**; Phase 5 replaces). Unauthenticated → `401 {error:{code,message}}`. `/api/health` remains the only unauthenticated route.
- **Documented payload schema:**

```jsonc
POST /api/ingest/scanner_json
X-API-Key: <key>
{
  "batchRef": "nessus-2026-07-11T02:00Z",     // optional; echoed to ingestion_batches
  "observedAt": "2026-07-11T02:00:00Z",       // optional; defaults to server receipt time
  "observations": [
    {
      "kind": "device",
      "externalId": "nessus-host-4412",
      "matchKeys": { "macAddresses": ["00:1A:2B:3C:4D:5E"], "hostname": "web01", "domain": "corp.example" },
      "fields": { "environment": "physical", "deviceClass": "enterprise_asset",
                  "enterpriseAssetType": "server" },
      "interfaces": [ { "macAddress": "00:1A:2B:3C:4D:5E",
                        "ips": [ { "address": "10.2.3.4", "observedAt": "2026-07-11T02:00:00Z" } ] } ]
    },
    {
      "kind": "software",
      "externalId": "nessus-sw-991",
      "identity": { "title": "OpenSSL", "publisher": "OpenSSL Project", "version": "3.0.2" },
      "fields": { "softwareType": "library", "cpe": "cpe:2.3:a:openssl:openssl:3.0.2:*:*:*:*:*:*:*" },
      "installedOnExternalId": "nessus-host-4412"
    }
  ]
}
```
- **Response:** `200 IngestionBatchResult` (batchId, received, staged, quarantined[], reconciliation summary). Malformed observations are quarantined per-row; the batch is not rejected wholesale unless the envelope itself is invalid (`400`).

---

## 10. DHCP Connector #4 (design-for, Safeguard 1.4 — not built)

DHCP proves the abstraction extends by *configuration*, not new pipeline code:

- **Definition:** `sourceType: "dhcp_log"`, capabilities `{ mode: "push", entityKinds: ["device"], matchKeys: ["mac_address","hostname_domain"], providesRequiredFields: false, incremental: false }`, `precedence: 20`.
- **Endpoint:** the *same* `POST /api/ingest/dhcp_log` push route; a lease event `{ mac, ip, hostname, leaseTime }` → `DeviceObservation` with `matchKeys.macAddresses`/`hostname` and an `interfaces[].ips[]` entry.
- **Reconciliation behavior falls out of the existing rules:** MAC matches an existing device → refresh IP history + `last_seen` (§6.4); MAC matches nothing → `new_asset` → **review** (not silent create), which is exactly "an unknown device took a lease" — the Safeguard 1.4 signal. Weak-key-only + conflicting hostname → review (never auto-merge). No engine changes; only a connector object + a `sources` row + an API key.

The same paragraph template (source API, auth, canonical field mapping, contributed match keys) is the shape every roadmap connector (Entra, Azure, Intune, AWS, Google) will fill — ROADMAP.md (Prompt 6.2) reuses it.

---

## 11. Architecture, Testing, Boundaries, Success

### 11.1 Placement (AGENTS.md §4.1 — strict layering)

```
connectors/types.ts, schemas.ts, registry.ts, manual.ts, csv/…, scanner_json.ts
                                   → pure: Connector impls + Zod; NO SQL/driver imports (boundary test C3 covers this dir)
services/ingestion_service.ts      → Normalize→Stage; calls repository interfaces + registry only
services/reconciliation_service.ts → Reconcile→Merge; match-key engine; field precedence
services/review_service.ts         → human resolution of the queue
routes/api/ingest/[sourceType].ts  → authenticated push endpoint (auth STUB in Phase 3)
db/migrations/0002_ingestion.sql   → additive schema (§8)
db/repositories/interfaces|turso/  → new IIngestionBatchRepository, IReviewQueueRepository; source-record reconciliation methods
```

Composition root wires the two new repositories and the three services into app state alongside the existing `Repositories` bundle; routes/islands resolve services from state (never construct them, never see the driver).

### 11.2 Testing strategy (TDD-first, Prompt 3.2)

- **Reconciliation unit tests (the crown jewels):** unique strong-key → auto-merge; **two sources, same MAC, different hostnames → queued, NOT merged** (gate case); multiple candidates → queue; no-match + `providesRequiredFields:false` → review; no-match + `true` → create `pending_review`; field precedence (higher rank overwrites, manual override immune, equal rank → recency); `last_seen` refresh without spurious `updated_at`/audit noise.
- **Connector unit tests:** `normalize` is pure and total (bad row → `RowError`, never throws); CSV column-mapping + malformed-row quarantine with the exact error report; scanner envelope validation (bad envelope → 400, bad observation → per-row quarantine); untrusted-payload round-trips verbatim and is never interpreted (AGENTS.md §2.7).
- **Schema/enum-parity tests:** every new CHECK in 0002 rejects an out-of-enum value; the `sources.source_type` rebuild preserves existing rows; TS enum arrays ↔ SQL CHECK lists set-equal (same harness as Slice A6).
- **Review-queue tests:** `list` filters (status/entityKind/reason/confidence/source/attribute-contains) and sorts by a projected attribute; `bulkCreateNew` promotes N selected `new_asset` items with one criticality + business_impact, writing one `create` audit entry each, and reports per-item failures (e.g. an already-resolved item) without aborting the rest.
- **Auth-stub tests:** ingest endpoint 401 without key, 200 with configured key, actor recorded as `connector`.
- **End-to-end gate test:** 50-device CSV + overlapping scanner JSON → duplicates reconcile, exactly one deliberate ambiguity queued, every merge produced an audit entry.
- Temp-file DB per test (WAL sidecar cleanup); fixtures synthetic only, under `tests/fixtures/`.

### 11.3 Boundaries

- **Ask first (AGENTS.md §8):** changing the §6.1 match-key order or precedence ranks; adding any dependency (a CSV parser — prefer a Deno-std/no-dep line parser; flag if one is proposed); altering `0001_initial.sql` (forbidden — use 0002); any auth/audit change.
- **Never:** a connector that writes canonical/inventory tables directly (§4.2); auto-merging an ambiguous match; auto-creating an asset that would violate NOT NULL criticality/business_impact; interpreting ingested payload text as instructions; committing real inventory data.
- **Always:** untrusted rows validated + quarantined per-row with a report, never partially guessed; every merge/create/status change audited via the repository `AuditContext`; new assets born `pending_review`/`unauthorized`.

### 11.4 Success criteria

1. PRD approved (this gate).
2. One `Connector` interface; three connectors implemented as pure objects registered in one registry; a fourth (DHCP) addable without service/engine edits (demonstrated by §10 being config-only).
3. Reconciliation outcomes match §6.2 exactly, proven by unit tests including the same-MAC/different-hostname queueing case.
4. Field-level precedence (§6.3) resolves conflicts deterministically; manual overrides survive automated re-observation.
5. Malformed input is quarantined with a per-row downloadable error report; valid-but-ambiguous input is queued; neither corrupts canonical inventory. The review queue is sortable/filterable and supports bulk criticality enrichment across multi-selected `new_asset` items (gate decision 1).
6. The Phase 3 gate end-to-end test passes; every merge wrote an audit entry.
7. `connectors/` and `services/` contain zero SQL/driver imports (architecture-boundary test still green); `0002` is additive and `0001` untouched.

---

## 12. Gate Decisions (resolved 2026-07-11)

1. **New-asset-from-automated-source → review queue, not silent create (Assumption 1)** — **RESOLVED: confirmed.** Automated no-match observations queue for human enrichment; no auto-create with a placeholder criticality. **Added requirement:** the review queue must be **sortable and filterable by attribute columns**, and support **multi-select bulk enrichment** — select many `new_asset` items and apply one criticality (+ business_impact) to all in a single audited action, so a queue of freshly-discovered devices drains efficiently. Reflected in §7 (`ReviewService.list(filter, sort, page)`, `bulkCreateNew`, `ReviewItem.attributes`) and §11.2/§11.4.
2. **Field precedence policy (Assumption 2)** — **RESOLVED: confirmed.** Manual override wins → source `precedence` rank → recency; default ranks manual 100 / cloud 80 / scanner 50 / csv 40 / dhcp 20 accepted as the configurable defaults.
3. **`sources.source_type` CHECK via table rebuild in 0002 (Assumption 8)** — **RESOLVED: approved.** The rebuild ships in `0002_ingestion.sql`; confirms core-PRD gate decision 3.
4. **Synchronous per-batch reconciliation (Assumption 3) + no removal-by-absence (Assumption 5)** — **RESOLVED: accepted for now.** Async reconciliation and staleness/absence policies remain roadmap items.
