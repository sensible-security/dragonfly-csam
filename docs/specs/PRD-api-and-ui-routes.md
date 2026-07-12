# PRD: Dragonfly CSAM — API & UI Routes (Fresh Routing Layer)

**Status:** APPROVED — gate questions resolved 2026-07-11 (see §13)
**Source prompt:** DEVELOPMENT_PLAN.md, Prompt 4.1
**Compliance scope:** Surfaces CIS v8.1 Controls 1 & 2 (Safeguards 1.1, 1.2, 2.1–2.4) and NIST CSF 2.0 ID.AM-01/-02/-04/-05 through a queryable API (GV support) + an operator UI. Auth (all-routes) is **Phase 5**.
**Authority:** AGENTS.md §4.1 (layering), §4.3 (API-first), §4.4 (audit), §6 (Beer CSS/Fresh), §8 (untrusted input, auth)
**Builds on:** [PRD-core-data-model.md](./PRD-core-data-model.md) (APPROVED) and [PRD-ingestion-pipeline.md](./PRD-ingestion-pipeline.md) (APPROVED, Phase 3 shipped). The repositories, the Ingestion/Reconciliation/Review services, the connector registry, and the composition root (`db/container.ts` → Fresh app state) already exist and are green.

---

## Assumptions I'm Making

Decisions the source materials leave open. Each is otherwise proceeded with as written; the three most architecture-shaping (1, 2, 3) are re-surfaced as gate questions in §13.

1. **Single-asset "create" is a connector action, not a direct repository insert.** AGENTS.md §4.2 is explicit: "Manual entry … must be built on the same abstraction that future connectors will use" and "Never write a connector that inserts directly into inventory tables." Therefore `POST /api/devices` and `POST /api/software` wrap the submitted canonical payload as a **manual `Observation`** and call `IngestionService.ingest({ sourceType: "manual", … })`. The asset is created through Reconcile→Merge, so it gets field provenance, audit, and — critically — **reconciliation**: a manual create that collides with an existing asset merges or queues for review rather than silently duplicating. The response therefore reports an *outcome* (`created` with the new id, `auto_merged` into an existing id, or `queued` with a review-item id), not an unconditional 201. (Gate Q1.)
2. **Edits and status transitions are direct, audited repository operations — not pipeline runs.** A human editing a canonical field (`PATCH /api/devices/[id]`) or flipping authorization status (`AssetStatusToggle` → status action) is a deliberate act on an existing row, not an "observation." These call the audited setters directly: `IDeviceRepository.update` / `setStatus`, `ISoftwareRepository.update` / `setAuthorizationStatus` / `setSupportStatus`. Routing them through ingestion would misattribute provenance to a "manual source" and fight the field-precedence engine. (Gate Q1.)
3. **Route handlers resolve the data layer from app state and call it directly; Phase 4 adds no per-entity CRUD service.** The composition root already exposes both `repositories` and `services` on `ctx.state`. Read routes (list/detail) and single-field/status writes call the **repository interfaces** (the pure, audited, no-SQL-leak layer — exactly as the existing `routes/api/health.ts` already does). Multi-step operations call the **services** that own them: create → `services.ingestion`, review resolutions → `services.review`, CSV import → `services.ingestion`. Introducing an empty `DeviceService`/`SoftwareService` that only forwards to a repository would be indirection without logic. This is a pragmatic reading of §4.1 (whose prose says "routes call services only") and is called out for confirmation. (Gate Q2.)
4. **No authentication in Phase 4.** AuthN/AuthZ for all routes is Prompt 5.1. Phase 4 builds routes **open** (except the already-stubbed API-key `routes/api/ingest/` endpoints) and designs them to be wrapped by a session-auth middleware in Phase 5 **without changing handler bodies**. `/api/health` stays permanently open. No secrets or PII in logs (AGENTS.md §8) applies now.
5. **The staging/source-record and audit-log APIs are read-only.** Staging is written only by the pipeline; the audit log is append-only by contract. Their routes expose list/detail (+ the batch error-report download) and nothing else.
6. **CSV upload is a session-authenticated UI action, distinct from the machine ingest endpoints.** Per PRD-ingestion Assumption 9, the manual & CSV connectors "run in-process (no HTTP auth); only push endpoints under `routes/api/ingest/` are authenticated [by API key]." So the analyst CSV upload is its own route — `POST /api/import/csv` (Phase-5 session-guarded) — carrying the file text + column mapping and calling `IngestionService`. It is **not** one of the API-key `routes/api/ingest/[sourceType]` endpoints.
7. **Pagination is offset/limit, mirroring `PageRequest`.** Every list endpoint accepts `?limit=&offset=` (default `limit=50`, max `200`, `offset=0`) and returns `{ items, total, limit, offset }` — the repository `Page<T>` shape, serialized verbatim.
8. **Filtering maps query parameters onto the existing repository `*Filter` types.** No new filter capabilities are invented; the API exposes exactly what the repositories already support (below). Every query string is Zod-parsed at the boundary; unknown or ill-typed params → `400 validation_error`.
9. **Dashboard KPI counts derive from filtered `list` totals**, not a new aggregate query — e.g. "unauthorized devices" = `devices.list({ status: "unauthorized" }, { limit: 1, offset: 0 }).total`. A dedicated stats query is a possible optimization noted for the build, not required for Phase 4.
10. **A "Review Queue" nav entry is added** to the app shell (`routes/_app.tsx` `NAV_ITEMS`) between Ingestion and Audit Log; the review queue is a first-class operator surface (gate decision 1 of the ingestion PRD).

---

## 1. Objective

Expose the Phase-1/2/3 inventory and pipeline through **(a)** a complete JSON API so SIEM/GRC/dashboards can query and drive the inventory (AGENTS.md §4.3, NIST GV support) and **(b)** a server-rendered Beer CSS operator UI for the daily analyst workflow: see the inventory, drill into an asset's provenance and history, drain the reconciliation queue, toggle authorization status, import a CSV, and read the audit trail.

**Users:** security analysts (UI + API), IT integrators and dashboards (API), auditors (audit-log viewer/API).

**Success looks like:** every capability in the UI is reachable via `routes/api/` returning JSON `Response`s; list/detail/create/update with pagination, filtering, Zod-validated input, and structured errors; a dashboard, two inventory tables, an asset-detail page with full provenance + interface/IP history, a working review queue, and an audit-log viewer; islands limited to the three interactive pieces (status toggle, review actions, CSV upload) with everything else server-rendered.

### Non-goals (this spec)

- **Authentication/authorization** → Phase 5 (Prompt 5.1). Routes are designed auth-wrappable; no login/roles here.
- **New connectors or reconciliation changes** → Phase 3 shipped; unchanged.
- **Service-provider and exception management UIs** → the API may expose them read-only where trivial, but full CRUD screens are roadmap (Control 15 / 2.2–2.3 workflows).
- **Implementation** — this is a markdown PRD (route map, request/response contracts, island boundaries). Build is Prompts 4.2–4.3.

---

## 2. Route Map

### 2.1 JSON API (`routes/api/…`)

| Method & path | Purpose | Data path (§Assumption 3) |
|---|---|---|
| `GET /api/health` | Liveness (exists) | repositories.auditLog |
| `GET /api/devices` | List + filter + paginate | devices.list |
| `POST /api/devices` | Create one device (manual connector) | services.ingestion |
| `GET /api/devices/[id]` | Detail: device + interfaces + IP history + installs + provenance + source records | devices, software, sourceRecords |
| `PATCH /api/devices/[id]` | Edit mutable fields | devices.update |
| `POST /api/devices/[id]/status` | Set asset status (1.2) | devices.setStatus |
| `GET /api/software` | List + filter + paginate | software.list |
| `POST /api/software` | Create one software (manual connector) | services.ingestion |
| `GET /api/software/[id]` | Detail: software + installs + exceptions + provenance | software, devices, sourceRecords |
| `PATCH /api/software/[id]` | Edit mutable fields | software.update |
| `POST /api/software/[id]/authorization` | Set authorization status (2.3) | software.setAuthorizationStatus |
| `POST /api/software/[id]/support` | Set support status (2.2) | software.setSupportStatus |
| `GET /api/source-records` | List staging records by source, paginate (read-only) | sourceRecords.listBySource |
| `GET /api/source-records/[id]` | Staging record detail (raw + normalized + reconciliation status) | sourceRecords.getById |
| `GET /api/review-queue` | List + filter + sort + paginate | services.review.list |
| `GET /api/review-queue/[id]` | Review item detail (candidates, attributes, source record) | reviewQueue.getById |
| `POST /api/review-queue/[id]/merge` | Confirm a candidate | services.review.merge |
| `POST /api/review-queue/[id]/create-new` | Promote w/ enrichment | services.review.createNew |
| `POST /api/review-queue/[id]/reject` | Reject | services.review.reject |
| `POST /api/review-queue/bulk-create-new` | Bulk promote selected items | services.review.bulkCreateNew |
| `GET /api/audit-log` | Query + filter + paginate (read-only) | repositories.auditLog.query |
| `GET /api/ingestion-batches/[id]/errors` | Downloadable CSV error report | ingestionBatches.listErrors |
| `POST /api/import/csv` | Session-auth CSV upload (file text + column mapping) | services.ingestion |
| `POST /api/ingest/[sourceType]` | Machine push ingest, API-key (exists) | services.ingestion |

### 2.2 UI (`routes/…`, server-rendered)

| Path | Page | Islands used |
|---|---|---|
| `/` | Dashboard — inventory KPI cards | — |
| `/devices` | Device inventory table + filters | — |
| `/devices/[id]` | Device detail — provenance, interfaces, IP history, installs | `AssetStatusToggle` |
| `/software` | Software inventory table + filters (EOL/unsupported flags) | — |
| `/software/[id]` | Software detail — installs, exceptions, provenance | `AssetStatusToggle` (authorization) |
| `/review-queue` | Reconciliation review queue | `ReviewQueueActions` |
| `/ingestion` | Ingestion — CSV upload + recent batches + error reports | `CsvImportUploader` |
| `/audit-log` | Audit-log viewer + filters | — |

---

## 3. API Design Conventions

- **Content type:** requests and responses are `application/json` (except the CSV error-report download, `text/csv`). Handlers return `Response.json(...)`.
- **Pagination:** `?limit=&offset=` → `{ items: T[], total, limit, offset }`. Defaults `limit=50`, clamp `1..200`; `offset≥0`.
- **Filtering:** query params map 1:1 to repository filter fields (§4). Absent params = no filter. Values Zod-validated against the taxonomy enums; an out-of-enum filter value is a `400`, not an empty result.
- **Validation:** every request (query + body) is parsed by a Zod schema at the boundary (AGENTS.md §8, §4.3). Bodies reuse/extend the connector schemas where shapes overlap (e.g. a device create body is the canonical device-observation `fields` + `matchKeys`).
- **Structured errors:** `{ "error": { "code": string, "message": string, "details"?: unknown } }`. Canonical codes and HTTP status:

  | Domain error / condition | code | HTTP |
  |---|---|---|
  | Zod/query/body invalid | `validation_error` | 400 |
  | (Phase 5) missing/invalid session | `unauthorized` | 401 |
  | `NotFoundError` | `not_found` | 404 |
  | `DuplicateAssetError` | `conflict` | 409 |
  | `TaxonomyViolationError` | `taxonomy_violation` | 422 |
  | `MissingCriticalityError` | `missing_required_fields` | 422 |
  | review item not pending / bulk partial | `not_pending` (per-item) | 200 w/ `BulkResult`, or 409 single |
  | unexpected | `internal_error` | 500 |

  A shared `toErrorResponse(err)` maps typed domain errors (from `db/repositories/interfaces/errors.ts`) to these — never leaking a driver message. **Payload values are never echoed back as instruction text** (AGENTS.md §2.7); error `details` carry field/code only.
- **Idempotency & audit:** every write inherits an `AuditContext` (Phase 5 fills `actorId` from the session; Phase 4 uses a fixed `{ actorType: "user", actorId: "system" }` placeholder — replaced, not re-plumbed, in Phase 5). Reads write nothing.

---

## 4. API Routes — Detail

### 4.1 Devices

- **`GET /api/devices`** — filters map to `DeviceFilter`: `status`, `deviceClass`, `enterpriseAssetType`, `environment`, `criticality`, `department`, `hostnameContains` (`?hostname=`). Returns `Page<Device>`.
- **`GET /api/devices/[id]`** — a composed detail DTO:
  ```ts
  interface DeviceDetail {
    device: Device;
    interfaces: { interface: NetworkInterface; ipHistory: IpAssignment[] }[];
    installations: SoftwareInstallation[];          // + resolved software title/version
    provenance: FieldProvenance[];                  // which source owns each field
    sourceRecords: SourceRecord[];                  // staging rows that fed this asset
  }
  ```
  Provenance + interface/IP history are the **Safeguard 1.1 / ID.AM-05** payload the prompt calls out. `404 not_found` if absent.
- **`POST /api/devices`** — body = canonical device attributes (`matchKeys` + `fields`, camelCase, the connector shapes). Handler wraps it as a manual `DeviceObservation`, calls `ingestion.ingest`, and returns:
  ```ts
  interface CreateAssetResult {
    outcome: "created" | "auto_merged" | "queued";
    entityId?: string;     // created/auto_merged
    reviewItemId?: string; // queued
    batchId: string;
  }
  ```
  HTTP `201` for `created`, `200` for `auto_merged`/`queued`. (Gate Q1.)
- **`PATCH /api/devices/[id]`** — body = `UpdateDevice` subset; calls `devices.update`; returns the updated `Device`. Status is **not** patchable here (it has its own audited route).
- **`POST /api/devices/[id]/status`** — body `{ status: AssetStatus }`; calls `devices.setStatus`; returns updated `Device`. This is the endpoint `AssetStatusToggle` drives (Safeguard 1.2).

### 4.2 Software

- **`GET /api/software`** — filters map to `SoftwareFilter`: `softwareType`, `authorizationStatus`, `supportStatus`, `criticality`, `eolBefore` (`?eolBefore=YYYY-MM-DD`), `titleContains` (`?title=`). Returns `Page<Software>`; each row carries the **EOL/unsupported flag** derived from `supportStatus`/`eolDate`.
- **`GET /api/software/[id]`** — `{ software, installations (+ device hostname), exceptions, provenance, sourceRecords }`.
- **`POST /api/software`** — manual connector create (as devices).
- **`PATCH /api/software/[id]`** — `UpdateSoftware`; `software.update`.
- **`POST /api/software/[id]/authorization`** — `{ status: SoftwareAuthorizationStatus }`; `software.setAuthorizationStatus` (2.3; `exception_documented` requires an active exception — the repository already enforces this and returns `taxonomy_violation` if not).
- **`POST /api/software/[id]/support`** — `{ status: SupportStatus }`; `software.setSupportStatus` (2.2).

### 4.3 Source records (read-only)

- **`GET /api/source-records?sourceId=…`** — `sourceRecords.listBySource` (paginated). `sourceId` required (or a `sourceName` resolved via `getSourceByName`).
- **`GET /api/source-records/[id]`** — raw payload (verbatim, untrusted — rendered as inert text), normalized payload, `reconciliation_status`, matched entity.

### 4.4 Review queue

- **`GET /api/review-queue`** — filter → `ReviewQueueFilter` (`status` default `pending`, `entityKind`, `reason`, `confidence`, `sourceId`, `attributeContains` via `?attr=field:value`), sort → `ReviewQueueSort` (`?sortBy=&sortDir=`), paginate. Returns `Page<ReviewQueueItem>`.
- **`POST …/[id]/merge`** — `{ targetEntityId }` → `review.merge`.
- **`POST …/[id]/create-new`** — `{ criticality, businessImpact, owner?, department? }` (`RequiredFields`) → `review.createNew`.
- **`POST …/[id]/reject`** — `{ reason }` → `review.reject`.
- **`POST /api/review-queue/bulk-create-new`** — `{ itemIds: string[], enrichment: RequiredFields }` → `review.bulkCreateNew`; returns `BulkResult` (`succeeded[]`, `failed[]`) — `200` even on partial failure (per-item outcomes; gate decision 1 of the ingestion PRD).

### 4.5 Audit log (read-only)

- **`GET /api/audit-log`** — filter → `AuditFilter` (`entityType`, `entityId`, `actorId`, `action`, `occurredAfter`, `occurredBefore`), paginate → `repositories.auditLog.query`. Returns `Page<AuditEntry>` (before/after diffs as JSON strings; the viewer renders them).

### 4.6 CSV import + error report

- **`POST /api/import/csv`** — body `{ csvText: string, columnMapping: Record<string,string>, sourceName: string }` (or multipart file + mapping JSON). Calls `ingestion.ingest({ sourceType: "csv_import", sourceName, payload: csvText, options: { columnMapping } })`; returns the `IngestionBatchResult` (`received`, `staged`, `quarantined[]`, `reconciliation`). Session-auth (Phase 5), not API-key (§Assumption 6).
- **`GET /api/ingestion-batches/[id]/errors`** — `ingestionBatches.listErrors(id)` rendered as `text/csv` (`row, column, value, error`) with `Content-Disposition: attachment` — the **downloadable error report** (ingestion PRD §9.2).

---

## 5. UI Routes — Detail (Beer CSS, server-rendered; AGENTS.md §6)

Every page is an async route handler that resolves data from `ctx.state`, passes it to a server-rendered component as props, and renders semantic HTML (`<table class="border stripes scroll">`, `<article>`, `<dialog>`, floating-label fields with the load-bearing single-space placeholder). No `<div>` soup, no utility classes.

1. **`/` Dashboard** — KPI cards (Beer `<article class="…">` tiles): total assets; devices by status (authorized/unauthorized/quarantined/pending_review); devices by criticality; unauthorized software count; **EOL/unsupported software count**; pending review-queue count; recent ingestion batches. Counts from filtered `list().total` (§Assumption 9). Cards link to the corresponding filtered inventory/queue view.
2. **`/devices`** — inventory `<table border stripes scroll>`; **filters are GET-form submissions** (query params → `DeviceFilter`, so filtered views are shareable URLs and need no JS); columns include hostname, class/type, environment, status (chip), criticality, department; row → detail. Pagination via prev/next query links.
3. **`/devices/[id]`** — the `DeviceDetail` DTO rendered: identity + status (with the `AssetStatusToggle` island), **network interfaces with per-interface IP history** (append-only, newest first), installed software, and a **provenance panel** (which source last set each field, from `FieldProvenance`) + the staging records that fed it. This is the Safeguard 1.1 / ID.AM-05 evidence surface.
4. **`/software`** — inventory table with **EOL/unsupported flags** rendered as chips (`supportStatus` + `eolDate`); GET-form filters → `SoftwareFilter`; row → detail.
5. **`/software/[id]`** — software facts, installations (with host hostnames), documented exceptions, provenance; authorization status via `AssetStatusToggle`.
6. **`/review-queue`** — the pending queue as a sortable/filterable `<table>` (GET-form filters → `ReviewQueueFilter`, sort links → `ReviewQueueSort`); each row shows reason/confidence/candidates/projected attributes; multi-select checkboxes + the `ReviewQueueActions` island for merge/reject/create-new and **bulk create-new** (gate decision 1).
7. **`/ingestion`** — the `CsvImportUploader` island (upload → column-map → per-row error report), plus a server-rendered list of recent batches with links to their error-report download.
8. **`/audit-log`** — filterable (GET-form → `AuditFilter`) audit viewer; before/after diffs shown in a `<details>`/`<dialog>`; append-only, read-only.

Nav: add a **Review Queue** entry to `_app.tsx` `NAV_ITEMS` (icon e.g. `rule`/`fact_check`), between Ingestion and Audit Log.

---

## 6. Islands vs Server-Rendered (the explicit ask)

**Interactivity lives only in `islands/` and talks only to `routes/api/`** (AGENTS.md §6). Exactly three islands (Prompt 4.3):

| Island | Where | Calls | Behavior |
|---|---|---|---|
| `AssetStatusToggle.tsx` | device & software detail | `POST /api/devices/[id]/status`, `…/software/[id]/authorization` | optimistic switch among authorized/unauthorized/quarantined (device) or authorization statuses (software), with error rollback (Safeguard 1.2) |
| `ReviewQueueActions.tsx` | `/review-queue` | review-queue `merge`/`create-new`/`reject`/`bulk-create-new` | resolve one or many candidates; a `create-new`/`bulk` opens a `<dialog>` collecting criticality + business_impact enrichment |
| `CsvImportUploader.tsx` | `/ingestion` | `POST /api/import/csv`, error-report download | upload, map columns to canonical targets, show the per-row error report |

**Everything else is server-rendered:** dashboard, both inventory tables, both detail pages (except the toggle island embedded in them), the review-queue table shell, the audit viewer, and all filtering (GET forms, not JS). Rationale: Fresh zero-JS-by-default (AGENTS.md §1); filters as URLs are shareable and auditable; only genuinely stateful controls become islands. Islands **never** receive repository or service objects — only `routes/api/` responses.

---

## 7. Data-Access Wiring (§Assumption 3, Gate Q2)

- Route handlers resolve `ctx.state.repositories` and `ctx.state.services` (already populated by the composition root).
- **Reads and single-field/status writes** → repository interfaces directly (matches the shipped `routes/api/health.ts`).
- **Create** → `services.ingestion` (manual connector). **Review resolutions** → `services.review`. **CSV import** → `services.ingestion`.
- The architecture-boundary test already forbids SQL/driver imports in `routes/` and `islands/`; this design keeps that green (no new SQL, no driver, islands fetch via API only).

---

## 8. Validation, Errors, Security Posture

- **Zod at every boundary** — a `schemas` module per route group; query and body both parsed; taxonomy enums reuse the `as const` arrays.
- **Untrusted data** — staged raw payloads and any ingested free-text are rendered as inert text (escaped), never as HTML/markup and never interpreted (AGENTS.md §2.7).
- **Auth** — Phase 4 open; Phase 5 adds a session-auth middleware that guards every route except `/api/health`, plus the API-key guard already on `/api/ingest/`. Handlers are written so the middleware wraps them without edits; the `AuditContext.actorId` placeholder becomes the session identity.
- **No PII/secrets in logs**; structured errors only.

---

## 9. Testing Strategy (for Prompts 4.2–4.3)

- **API handler unit tests** (call exported handler fns directly, à la `checkHealth`, over a temp-DB stack): pagination clamps; each filter maps correctly; Zod rejects bad input → `400 validation_error`; domain errors map to the right status/code; `POST /api/devices` returns `created` vs `queued` vs `auto_merged` per reconciliation; status/authorization routes write audited transitions; review actions resolve and audit; `bulk-create-new` returns partial `BulkResult`; audit + source-record routes are read-only; CSV import returns the batch result and the error report downloads as CSV.
- **UI route tests** — handlers return 200 with expected data props; filters produce shareable query URLs; EOL/unsupported flags render; detail pages expose provenance + IP history.
- **Boundary test stays green** — no SQL/driver imports in `routes/`/`islands/`; islands import no service/repository types.
- **Accessibility checks** — tables have `<th>` headers; dialogs manage focus; status chips have text labels; filter forms have labeled fields.
- Temp-file DB per test; fixtures synthetic (`tests/fixtures/`).

---

## 10. Boundaries

- **Ask first (AGENTS.md §8):** changing the create-path decision (§Assumption 1); adding a dependency; any auth/audit change; altering the reconciliation contract.
- **Never:** SQL/driver/ORM in `routes/`, `islands/`, `components/`; islands receiving repository/service objects; a create path that bypasses reconciliation or writes canonical tables directly from a handler; echoing untrusted payload text as markup; utility-class CSS.
- **Always:** Zod-validate external input; structured errors; audited writes through the repository/service `AuditContext`; Beer CSS semantics + accessibility (§6).

---

## 11. Success Criteria

1. This PRD approved (gate).
2. Every UI capability has a JSON API equivalent under `routes/api/` returning structured JSON (§4.3 API-first).
3. List/detail/create/update exist for devices and software with pagination, taxonomy-filtering, Zod validation, and the structured-error contract (§3).
4. `POST /api/devices|software` flows through the manual connector → reconciliation (provenance + audit + collision handling), proven by tests (created / auto_merged / queued).
5. Status/authorization/support transitions are audited and go through the dedicated setters.
6. Review-queue list/detail + merge/create-new/reject/bulk-create-new work end-to-end and are audited; the queue is filterable/sortable and supports multi-select bulk enrichment.
7. Audit-log and source-record APIs are read-only and filterable.
8. UI: dashboard KPIs, both inventory tables (GET-form filters, `border stripes scroll`), asset-detail with provenance + interface/IP history, review queue, CSV import, audit viewer — all server-rendered except the three islands.
9. Islands (`AssetStatusToggle`, `ReviewQueueActions`, `CsvImportUploader`) talk only to `routes/api/`; architecture-boundary test green.
10. `deno task check` + full test suite green before `/review`.

---

## 12. Design-for (not built here)

- Service-provider (Control 15) and exception (2.2/2.3) management screens — API may expose read-only; full CRUD is roadmap.
- Saved views / CSV export of inventory; SIEM webhook push — API-first foundation is laid here.
- Real auth/roles (Phase 5) shape the middleware seam but no UI here.

---

## 13. Gate Decisions (resolved 2026-07-11)

1. **Q1 — Single-asset create path (§Assumptions 1–2)** — **RESOLVED: connector pipeline.** `POST /api/devices|software` routes through the **manual connector + reconciliation** (a UI/API create may return `created`, `auto_merged`, or `queued`), while **edits and status changes go directly** to the audited repository setters. Consistent with AGENTS.md §4.2.
2. **Q2 — Route → repository access (§Assumption 3)** — **RESOLVED: repositories direct.** Phase-4 route handlers call **repository interfaces directly** from app state for reads and single-field/status writes (as the shipped health route does); services own create/review/import. **No** empty per-entity CRUD service is introduced.
3. **Q3 — Create response semantics** — **RESOLVED: accepted as specified.** The `CreateAssetResult` shape (`outcome` ∈ created/auto_merged/queued with the relevant id) is the create contract; follows directly from Q1.
4. **Q4 — Dashboard KPI set (§Assumption 9, §5.1)** — **RESOLVED: accepted as specified.** Cards: asset totals, devices-by-status, devices-by-criticality, unauthorized software, EOL/unsupported software, pending review. Adjustable during the Prompt 4.2 build without a spec change.
