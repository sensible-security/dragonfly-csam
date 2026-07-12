# Dragonfly CSAM — Sequenced Development Plan (Agent Prompts)

Feed these prompts to your agent in order. Each phase ends at a verifiable gate; do not advance past a gate with failing checks. Prompts assume `AGENTS.md` is in the repo root and the agent-skills framework is installed.

Deviations from the Gemini playbook are deliberate: the connector/ingestion pipeline and reconciliation engine are promoted to Phase 3 (they are the product, not an afterthought), auth + audit logging are front-loaded, and all libSQL/sqld guidance is removed (the Rust Turso rewrite is an embedded, in-process database).

---

## Phase 0 — Scaffold & Guardrails

**Prompt 0.1 — Project scaffold**
> Initialize a Deno Fresh 2.x project for Dragonfly CSAM per AGENTS.md. Create the directory skeleton: `routes/`, `routes/api/`, `islands/`, `components/`, `services/`, `db/migrations/`, `db/repositories/interfaces/`, `db/repositories/turso/`, `connectors/`, `tests/`, `tests/fixtures/`. Add deno tasks: `start`, `build`, `test`, `check`, `db:migrate`. Add Beer CSS to the app shell (left nav drawer, top app bar, responsive main) with placeholder nav entries: Dashboard, Devices, Software, Ingestion, Audit Log. Add the Dockerfile (denoland/deno base, dependency-layer caching, `deno task build`, non-root deno user, exposed port). Verify `deno task start` boots and the Docker image builds. Do not add any database code yet.

**Prompt 0.2 — Turso spike (de-risk the beta dependency)**
> Write a small throwaway spike under `spikes/turso/` proving the Rust Turso client (`npm:@tursodatabase/database`) works in our Deno container: open a local `.db` file, create a table, insert, select, and run a transaction. Document in `spikes/turso/FINDINGS.md` any permission flags required (`--allow-ffi`, `--allow-read/write`), API quirks, and unsupported SQLite features encountered. If the client fails in-container, STOP and report options before we proceed.

**Gate:** dev server boots, Docker builds, spike findings reviewed by human.

---

## Phase 1 — Specification (Domain Model & Data Layer)

**Prompt 1.1 — Core data model spec**
> /spec Draft the PRD for the Dragonfly CSAM core data model and data access layer. It must fulfill CIS Safeguards 1.1, 1.2, 2.1, 2.2, 2.3 and NIST CSF ID.AM-01/-02/-04/-05 using the exact hierarchical taxonomy in AGENTS.md §5 (device class → enterprise asset type → end-user subtype; software type → component type). Cover: (a) devices with one-to-many network_interfaces carrying MAC and historical IP mappings; (b) software with publisher, version, deployment mechanism, license count, CPE, EOL/support status and documented-exception workflow; (c) device↔software install relationships with install date and discovery source; (d) mandatory criticality + business_impact on all assets; (e) service_providers; (f) the audit_log table (actor, action, entity, before/after diff, timestamp, source address); (g) source_records staging table with provenance (source_id, external_id, first_seen, last_seen, raw payload ref) and field-level provenance on canonical assets. Specify SQL CHECK constraints mirroring every enum. No implementation code — markdown PRD with an entity-relationship description and the repository interface contracts (IDeviceRepository, ISoftwareRepository, IServiceProviderRepository, IAuditLogRepository, ISourceRecordRepository) in domain types only.

**Prompt 1.2 — Plan the data layer**
> /plan Decompose the accepted data-model spec into atomic tasks: SQL migration files, migration runner, domain types + enums, repository interfaces, Turso repository implementations (hand-written SQL per AGENTS.md ORM policy), composition root / dependency injection into Fresh app state, and test suites. Each task gets acceptance criteria verifiable by `deno task test`.

**Gate:** human approves the PRD and plan.

---

## Phase 2 — Data Layer Build

**Prompt 2.1 — Interfaces, types, migrations**
> /build Execute the first tasks: write `db/migrations/0001_initial.sql` (all tables, CHECK constraints, indexes on match keys: serial, MAC, hostname), the migration runner, domain types/enums, and the repository interfaces. No Turso implementation yet — interfaces must compile against domain types only.

**Prompt 2.2 — Turso implementations (TDD)**
> /test then /build In strict TDD order: write failing Deno test suites for TursoDeviceRepository CRUD (including network interface IP history append, status transitions authorized→quarantined with audit entries, and rejection of records missing criticality/business_impact), then implement TursoDeviceRepository to pass. Repeat for Software, ServiceProvider, AuditLog, and SourceRecord repositories. Use a temp-file database per test run; never share state between tests.

**Prompt 2.3 — Composition root**
> /build Create the composition root that constructs repositories and services once and exposes them via Fresh app state. Add a health-check route `routes/api/health.ts` that verifies DB connectivity through the repository layer. Prove via a test that no file in routes/ or services/ imports the Turso client or SQL.

**Gate:** `deno task test` and `deno task check` green; grep confirms zero SQL/Turso imports outside `db/repositories/turso/`.

---

## Phase 3 — Ingestion Framework (Connectors, Reconciliation)

**Prompt 3.1 — Connector framework spec**
> /spec Draft the PRD for the ingestion pipeline: Source → Normalize → Stage → Reconcile → Merge → Inventory. Define the `Connector` TypeScript interface (id, source type, capability flags, receive/fetch, normalization mapping to canonical observation shapes for devices and software). Specify the reconciliation engine: ordered match keys (cloud instance ID > serial > MAC > hostname+domain), confidence outcomes (auto-merge, human-review queue, new asset), field-level source-of-truth precedence, and last_seen refresh semantics. Specify per-row validation and quarantine behavior for malformed input. The first three connectors: (1) manual entry (UI/API-driven), (2) CSV bulk import with column-mapping and downloadable error report, (3) generic authenticated JSON ingest endpoint for scanners (Safeguards 1.3, 1.5, 2.4) with a documented payload schema. Include how DHCP log ingestion (1.4) will later plug in as connector #4.

**Prompt 3.2 — Build the pipeline (TDD)**
> /plan then /build Decompose and implement the connector framework spec slice by slice: Connector interface + registry, normalization schemas (Zod), staging writes with provenance, reconciliation engine with unit tests covering ambiguous-match queueing (two sources, same MAC, different hostnames must NOT auto-merge), then the manual connector, then CSV import (fixture files in tests/fixtures/ including malformed rows), then the JSON ingest API route with authentication stub. Every merge writes audit entries.

**Gate:** end-to-end test: CSV of 50 devices + overlapping scanner JSON payload ingests, reconciles duplicates correctly, and queues one deliberate ambiguity for review.

---

## Phase 4 — API & UI

**Prompt 4.1 — Routes spec**
> /spec Draft the Fresh routing spec: JSON API routes (devices, software, source records, review queue, audit log — list/detail/create/update with pagination, filtering by status/type/criticality, Zod-validated input, structured errors) and UI routes (dashboard with inventory KPI cards; device inventory table; software inventory table with EOL/unsupported flags; asset detail page showing provenance and interface/IP history; reconciliation review queue; audit log viewer). Specify which pieces are islands (status toggle, review-queue actions, CSV upload) versus server-rendered.

**Prompt 4.2 — Inventory UI**
> /build Implement the device and software inventory pages server-side with Beer CSS semantic tables (`border stripes scroll`), filters as GET form submissions, and the asset detail page. Follow AGENTS.md §6 exactly (floating-label field structure with the single-space placeholder).

**Prompt 4.3 — Interactive islands**
> /build Implement islands: (a) `AssetStatusToggle.tsx` — switch an asset among authorized/unauthorized/quarantined (Safeguard 1.2) via PATCH to the API with optimistic UI and error rollback; (b) `ReviewQueueActions.tsx` — merge/reject reconciliation candidates; (c) `CsvImportUploader.tsx` — upload, column-map, show per-row error report. Islands communicate only through routes/api.

**Gate:** manual walkthrough — create asset manually, import CSV, resolve a review-queue item, toggle a status, confirm each action appears in the audit log viewer.

---

## Phase 5 — AuthN/AuthZ & Hardening

**Prompt 5.1 — Authentication**
> /spec then /build Specify and implement session-based authentication for all routes (except /api/health) plus API-key auth for ingest endpoints, with roles: admin, analyst, read_only, connector. Wire the audit log actor field to the authenticated identity. Keep the auth provider swappable behind a service interface (future Entra ID SSO is on the roadmap).

**Prompt 5.2 — Review**
> /review Adopt the code-reviewer and security-auditor personas. Verify: Repository Pattern intact (no SQL/client leakage), connector pipeline not bypassed anywhere, taxonomy enums enforced by both TypeScript and SQL CHECK constraints, all external input Zod-validated, no secrets or PII in logs, Beer CSS semantics and accessibility (labels, table headers, dialog focus), API error handling consistent. Produce a remediation list; fix items via /build slices.

**Prompt 5.3 — Programmatic API read access (AGENTS.md §4.3, NIST CSF GV)**
> /spec then /build Close the §4.3 gap surfaced in the 5.2 review: API keys currently authenticate only `/api/ingest/`, and the sole session issuer is the form-encoded login page, so SIEM/GRC/dashboard tooling has no programmatic credential for the read APIs (`GET /api/devices`, `/api/software`, `/api/source-records`, `/api/audit-log`, `/api/review-queue`). Extend the auth guard so a connector API key authenticates read-only (GET/HEAD) access to the JSON inventory/read endpoints in addition to ingest, while still being refused on UI routes and on every mutation and admin endpoint (an API key grants no write access anywhere; a session cookie is still not a credential for ingest — keep the channel separation explicit). Reconcile AGENTS.md §8 ("all routes require authentication except health checks") and the guard's open-route/exemption list (health, login, static assets) with the auth PRD assumptions so the authoritative doc matches the code. Add guard tests: an API key GETs `/api/devices` (resolves a connector identity), is rejected on `POST /api/devices`, on `/api/admin/*`, and on UI routes.

**Gate:** review remediations complete; API keys read the inventory JSON APIs but cannot write or reach admin/UI routes; `deno task check` and full test suite green.

---

## Phase 6 — Ship & Roadmap

**Prompt 6.1 — Ship**
> /ship Finalize deployment: verify the Dockerfile (dependency caching, `deno task build`, non-root user, correct port, minimal permissions flags for the Turso client per the Phase 0 spike findings), add a docker-compose.yml mounting a persistent volume for the .db file, document backup strategy for the database file, and write DEPLOYMENT.md.

**Prompt 6.2 — Roadmap backlog**
> /spec Produce ROADMAP.md as a prioritized backlog with acceptance criteria per item: (1) DHCP log connector (Safeguard 1.4); (2) allowlist authoring + hash/library/script export (Safeguards 2.5–2.7); (3) Microsoft Entra connector; (4) Intune connector; (5) Azure Resource Graph connector; (6) AWS Config connector; (7) Google Workspace + Cloud Asset Inventory connectors; (8) CVE ingestion binding to CPE strings (Control 7); (9) DataClasses mapping (Control 3, Safeguard 3.2); (10) ConfigurationState drift linkage (Control 4); (11) Accounts module expansion (Controls 5/6, Safeguard 5.1); (12) service provider risk workflows (Control 15); (13) second database backend (Postgres repository implementations) as the agnosticism proof; (14) Entra ID SSO. For each connector, note the source API, auth mechanism, canonical field mapping, and which match keys it contributes to reconciliation.

---

## Working Rhythm

- One prompt per agent session where practical; start fresh sessions between phases (context hygiene).
- If the agent surfaces a CONFUSION or MISSING REQUIREMENT block, answer it before letting it proceed — that behavior is required by AGENTS.md, not a malfunction.
- After every /build slice: `deno task check && deno task test` locally before accepting.
