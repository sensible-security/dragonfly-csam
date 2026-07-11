# PLAN: Dragonfly CSAM — Data Layer Task Breakdown

**Status:** APPROVED — plan and A0 (exact pin `@tursodatabase/database@0.6.1`) approved by human 2026-07-10 (Phase 1 gate passed)
**Source prompt:** DEVELOPMENT_PLAN.md, Prompt 1.2
**Inputs:** [PRD-core-data-model.md](../specs/PRD-core-data-model.md) (approved 2026-07-10), AGENTS.md §4–§5, spikes/turso/FINDINGS.md
**Executes as:** Phase 2 — Prompt 2.1 (Slice A), Prompt 2.2 (Slice B), Prompt 2.3 (Slice C)

Every task below is atomic (one focused build step), has acceptance criteria verifiable by `deno task test` (plus `deno task check`), and names its dependencies. Nothing outside `db/`, `routes/api/health.ts`, `tests/`, and the root manifest is touched.

---

## Planning Decisions (surfaced per AGENTS.md §2)

These are choices the PRD leaves to the plan. Flag any objection before approving.

1. **The migration runner and connection factory live under `db/repositories/turso/`** (`connection.ts`, `migrator.ts`), because the Phase 2 gate greps for *zero SQL/Turso imports outside `db/repositories/turso/`* and both modules must import the driver. `deno task db:migrate` points at a thin CLI entry (`db/repositories/turso/migrate.ts`). Migration *SQL files* stay in `db/migrations/` per AGENTS.md — they are data read by the runner, not imports.
2. **Audit atomicity is implemented as an internal `writeAuditEntry(conn, …)` helper** in `db/repositories/turso/audit.ts`, called by every mutating repository method inside its open transaction. `TursoAuditLogRepository.append` wraps the same helper. Repositories do **not** call `IAuditLogRepository` across transaction boundaries — that couldn't be atomic. This satisfies PRD §3.4 without a unit-of-work abstraction.
3. **Build order within Slice B puts the audit helper + AuditLog repository first**, since every other repository depends on the helper. DEVELOPMENT_PLAN Prompt 2.2 lists Device first; the TDD *rhythm* (failing tests → implement, one repository at a time) is preserved, only the order changes. The Device repository remains the first *full* CRUD implementation.
4. **The `@tursodatabase/database` dependency addition needs explicit approval** (AGENTS.md §8; flagged in spike findings). Task A0 is the approval checkpoint — no Slice A build session starts until the human answers it, ideally at this plan's gate review. Proposed pin: `npm:@tursodatabase/database@0.6.1` (exact version verified by the spike; pre-1.0 → no caret).
5. **Migration tracking table is `_migrations`** (filename, applied_at), giving idempotent re-runs. It is runner infrastructure, not domain schema, so it appears in the runner, not in `0001_initial.sql`.
6. **"Rejects records missing criticality/business_impact"** (Prompt 2.2) is tested at two layers: TS (compile-time required fields) can be bypassed by untyped callers, so repositories validate presence/non-emptiness and throw `MissingCriticalityError`; the SQL NOT NULL constraint is asserted independently in the schema tests as the last line of defense.

---

## Slice A — Interfaces, Types, Migrations (executes Prompt 2.1)

### A0. Dependency approval checkpoint *(blocking; human)*

Add `@tursodatabase/database@0.6.1` (exact pin) to the root `deno.json` imports.

- **Depends on:** plan approval.
- **Acceptance:** human has approved the addition; `deno install` succeeds; `deno task check` green with the new import map entry; no other dependency added.

### A1. Taxonomy enums as `as const` arrays

`db/repositories/interfaces/taxonomy.ts`: all 13 enums from PRD §2.2 (`DEVICE_CLASSES`, `ENTERPRISE_ASSET_TYPES`, `END_USER_DEVICE_SUBTYPES`, `ENVIRONMENTS`, `ASSET_STATUSES`, `CRITICALITIES`, `SOFTWARE_ASSET_TYPES`, `SOFTWARE_COMPONENT_TYPES`, `SOFTWARE_AUTHORIZATION_STATUSES`, `SUPPORT_STATUSES`, `PROVENANCE_ENTITY_TYPES`, `AUDIT_ACTOR_TYPES`, `AUDIT_ACTIONS`) in the PRD §6 idiom — array + derived union type. Values copied character-for-character from AGENTS.md §5; no additions, no flattening.

- **Depends on:** nothing (pure types).
- **Acceptance:** `deno task check` green; the Slice A parity test (A6) consumes these arrays; a reviewer can diff every value against AGENTS.md §5 one-to-one.

### A2. Domain entities, input types, shared types, domain errors

`db/repositories/interfaces/` — one file per entity group per PRD §6:

- Entities mirroring PRD §2.3 field-for-field in camelCase: `Device`, `NetworkInterface`, `IpAssignment`, `Software`, `SoftwareInstallation`, `SoftwareException`, `ServiceProvider`, `Source`, `SourceRecord`, `FieldProvenance`, `AuditEntry`.
- `Create*` inputs (omit `id`, timestamps), `Update*` patches (`Partial` of mutable fields).
- Shared: `Page<T>`, `PageRequest`, `AuditContext`, plus filter types `DeviceFilter`, `SoftwareFilter`, `AuditFilter` exactly as PRD §3.3.
- Domain errors in `errors.ts`: `TaxonomyViolationError`, `DuplicateAssetError`, `MissingCriticalityError`, `NotFoundError` (PRD §3.5) — plain `Error` subclasses, no driver types.

- **Depends on:** A1.
- **Acceptance:** `deno task check` green; zero imports from `db/repositories/turso/` or `npm:` specifiers anywhere in `db/repositories/interfaces/` (enforced permanently by test C3).

### A3. The five repository interfaces

`db/repositories/interfaces/`: `IDeviceRepository`, `ISoftwareRepository`, `IServiceProviderRepository`, `IAuditLogRepository`, `ISourceRecordRepository` — signatures verbatim from PRD §3.3 (all methods `Promise`-returning; every mutation takes `AuditContext`; `IAuditLogRepository` exposes no update/delete).

- **Depends on:** A2.
- **Acceptance:** `deno task check` green; interfaces reference only A1/A2 types; method sets match PRD §3.3 exactly (reviewer diff).

### A4. `db/migrations/0001_initial.sql`

All ten tables from PRD §2.3 (`devices`, `network_interfaces`, `ip_assignments`, `software`, `device_software`, `exceptions`, `service_providers`, `sources`, `source_records`, `field_provenance`, `audit_log` — sources included), with:

- CHECK constraints for every PRD §2.2 enum column (13 enums; `sources.source_type` deliberately unconstrained per gate decision 3).
- Both device hierarchy CHECKs and the software component-type hierarchy CHECK (PRD §2.3).
- `license_count >= 0` CHECK; NOT NULLs per PRD tables including `criticality`/`business_impact`; defaults (`pending_review`, `unauthorized`, `supported`).
- UNIQUEs: `network_interfaces(device_id, mac_address)`, `software(title, publisher, version)`, `device_software(device_id, software_id)`, `service_providers(name)`, `sources(name)`, `source_records(source_id, external_id)`, `field_provenance(entity_type, entity_id, field_name)`.
- All FKs; all PRD §2.4 indexes (match keys: `cloud_instance_id`, `hardware_serial`, `(hostname, domain)`, `mac_address`; plus hot-path and audit indexes).

- **Depends on:** nothing (plain SQL file), but reviewed against A1 values.
- **Acceptance:** schema tests A6 pass; file is forward-only and never edited after this slice ships (AGENTS.md §8).

### A5. Connection factory + migration runner

`db/repositories/turso/connection.ts`: `openDatabase(path): Promise<DatabaseConnection>` — connects via `@tursodatabase/database`, sets `PRAGMA foreign_keys = ON` on **every** connection (spike finding: defaults OFF).
`db/repositories/turso/migrator.ts`: reads `db/migrations/*.sql` in filename order, applies each not yet recorded in `_migrations` inside a transaction, records it. Exported as a function callable with any DB path (tests need temp files).
`db/repositories/turso/migrate.ts`: CLI entry; update `deno task db:migrate` to run it with the minimal flags from the spike (`--allow-read --allow-write --allow-ffi --allow-env`).

- **Depends on:** A0, A4.
- **Acceptance (via `deno task test`):** runner applies 0001 to a fresh temp-file DB; running it twice is a no-op (idempotent — `_migrations` has one row, schema unchanged); a deliberately broken migration in a fixture dir rolls back and leaves `_migrations` unrecorded; `PRAGMA foreign_keys` reports ON on factory connections.

### A6. Schema + parity test suite

`tests/repositories/schema_test.ts` (+ `tests/repositories/helpers.ts`, the temp-file-DB-per-test harness with WAL sidecar cleanup, reused by all of Slice B):

- Migration applies cleanly to a fresh temp DB.
- Every enum CHECK rejects one out-of-enum value per column (parameterized over A1 arrays).
- Hierarchy CHECKs reject: `removable_media` + non-NULL `enterprise_asset_type`; `enterprise_asset` + NULL type; subtype on a non-`end_user_device`; `firmware` + `component_type`.
- NOT NULL rejections for `criticality` and `business_impact` on both `devices` and `software`.
- FK enforcement: orphan `network_interfaces`/`ip_assignments`/`source_records` inserts rejected.
- **Enum parity test:** extract each CHECK's value list from `0001_initial.sql` by regex and assert set-equality with the A1 arrays (TS ↔ SQL cannot drift).

- **Depends on:** A1, A4, A5.
- **Acceptance:** `deno task test` green; removing any single CHECK from the migration or any value from a TS array makes at least one test fail.

**Slice A definition of done:** `deno task check && deno task test` green; interfaces compile against domain types only; no repository implementations exist yet.

---

## Slice B — Turso Repository Implementations, strict TDD (executes Prompt 2.2)

Rhythm for every task: write the failing test suite first, run `deno task test` to see it fail, implement until green, then `deno task check`. Temp-file DB per test via the A6 harness; never share state between tests. All SQL hand-written (AGENTS.md ORM policy); driver `SqliteError`s translated to A2 domain errors at the repository boundary.

### B1. Audit write helper + `TursoAuditLogRepository`

`db/repositories/turso/audit.ts` (internal `writeAuditEntry(conn, entry)`) and `db/repositories/turso/audit_log_repository.ts`.

- **Depends on:** Slice A.
- **Acceptance (failing-first):** `append` persists all PRD audit fields and returns the entry; `query` filters by entityType/entityId/actorId/action/occurredAfter/occurredBefore with pagination and `total`; the concrete class has no update/delete members; rows are immutable through the public surface.

### B2. `TursoDeviceRepository`

`db/repositories/turso/device_repository.ts`.

- **Depends on:** B1.
- **Acceptance (failing-first), covering Prompt 2.2's named cases:**
  - `create` persists a full device and writes a `create` audit entry **in the same transaction** (crash-simulation test: constraint failure at audit-write time leaves no device row).
  - `create` with missing/empty `criticality` or `business_impact` (via untyped input) throws `MissingCriticalityError`; nothing persisted.
  - Taxonomy violations (bad enum, `removable_media` + asset type) throw `TaxonomyViolationError`, not a driver error.
  - `getById` returns null for unknown id; `update` re-validates hierarchy rules and writes an `update` audit entry with before/after diff.
  - `setStatus('authorized' → 'quarantined')` persists the transition and writes a `status_change` audit entry with before/after JSON (Safeguard 1.2).
  - `addInterface` enforces `(device_id, mac_address)` uniqueness → `DuplicateAssetError`; MAC normalized to uppercase colon-separated.
  - `recordIpObservation`: same current IP refreshes `last_seen` (no new row); a different IP appends a row; history is never rewritten (`listIpHistory` shows both, ordered).
  - `list` honors every `DeviceFilter` field and pagination (`total` correct).

### B3. `TursoSoftwareRepository`

`db/repositories/turso/software_repository.ts`.

- **Depends on:** B1.
- **Acceptance (failing-first):**
  - CRUD with audit entries as in B2; `(title, publisher, version)` duplicate → `DuplicateAssetError`; missing criticality/business_impact → `MissingCriticalityError`; `firmware` + `component_type` → `TaxonomyViolationError`.
  - `setAuthorizationStatus` / `setSupportStatus` write `status_change` audit entries atomically.
  - Active-exception invariant (PRD §2.3-exceptions): `setAuthorizationStatus('exception_documented')` with zero active exceptions is rejected; succeeds after `addException`; `revokeException` sets `revoked_at` and `listActiveExceptions` excludes it.
  - `recordInstallation` / `markUninstalled` / reinstall reactivation (clears `uninstalled_at` on the same row — still one row per `(device, software)`); `listInstallationsForDevice/Software` correct.
  - `list` honors `SoftwareFilter` including `eolBefore`.

### B4. `TursoServiceProviderRepository`

`db/repositories/turso/service_provider_repository.ts`.

- **Depends on:** B1.
- **Acceptance (failing-first):** create/getById/list/update with audit entries; duplicate `name` → `DuplicateAssetError`; pagination correct.

### B5. `TursoSourceRecordRepository`

`db/repositories/turso/source_record_repository.ts`.

- **Depends on:** B1.
- **Acceptance (failing-first):**
  - `registerSource` / `getSourceByName`; duplicate source name → `DuplicateAssetError`.
  - `upsertObservation` keyed `(sourceId, externalId)`: first insert sets `first_seen = last_seen`; re-observation refreshes `last_seen` and both payloads while `first_seen` is unchanged; writes `ingest` audit entries.
  - `raw_payload` stored verbatim — a fixture payload containing instruction-like text (e.g. "ignore all previous instructions") round-trips byte-identical and is never interpreted (AGENTS.md §2.7).
  - `setFieldProvenance` upserts on `(entity_type, entity_id, field_name)`; `getFieldProvenance` returns current ownership rows.

**Slice B definition of done:** `deno task check && deno task test` green; every mutating method demonstrably writes its audit entry atomically; no test touches a shared DB file.

---

## Slice C — Composition Root & Wiring (executes Prompt 2.3)

### C1. Composition root

`db/container.ts`: constructs one connection (factory from A5, migrations applied on boot), instantiates the five Turso repositories **once**, returns a typed `Repositories` bundle exposed via Fresh app state (`createDefine` state per Fresh 2.x). Route handlers resolve repositories/services from state — never construct them.

- **Depends on:** Slice B.
- **Acceptance:** a test builds the container against a temp DB and gets working repositories; container is constructed exactly once per process (module-level or app-init semantics asserted); DB path comes from env/config, not hardcoded.

### C2. Health check route

`routes/api/health.ts`: verifies DB connectivity **through the repository layer** (e.g. an `IAuditLogRepository.query` with limit 1 — no SQL, no driver import), returns `{ status: "ok" }` or a structured 503 error per AGENTS.md §4.3.

- **Depends on:** C1.
- **Acceptance:** handler test — healthy DB → 200 JSON; container pointed at an unopenable path → 503 with `{ error: { code, message } }`; file imports nothing from `turso/` except via the container's interface types.

### C3. Architecture-boundary test

`tests/architecture_test.ts`: walks all `.ts`/`.tsx` under `routes/`, `services/`, `islands/`, `components/`, and `db/repositories/interfaces/`, asserting none imports `@tursodatabase/database` or any module under `db/repositories/turso/` (composition root `db/container.ts` is the sole sanctioned importer outside that directory) and none contains SQL strings. This makes the Phase 2 grep gate a permanent regression test.

- **Depends on:** C1, C2.
- **Acceptance:** test passes; adding a deliberate `import … from "…/turso/…"` to a scratch route makes it fail (verified once during development, then removed).

**Slice C / Phase 2 gate:** `deno task check && deno task test` green; grep confirms zero SQL/Turso imports outside `db/repositories/turso/` (now enforced by C3 forever).

---

## Dependency Graph & Session Mapping

```
A0 (approval) ─┬─▶ A5 ─▶ A6 ─▶ [Slice B: B1 ─▶ B2, B3, B4, B5] ─▶ C1 ─▶ C2 ─▶ C3
A1 ─▶ A2 ─▶ A3 ─┤        ▲
A4 ─────────────┴────────┘
```

- **Session 1 (Prompt 2.1):** A0–A6. **Session 2 (Prompt 2.2):** B1–B5 (B2–B5 may be separate sub-sessions; B1 first). **Session 3 (Prompt 2.3):** C1–C3.
- After every task: `deno task check && deno task test` before proceeding (AGENTS.md §2.6, DEVELOPMENT_PLAN working rhythm).
- Out of scope, deliberately: services layer, Zod boundary schemas, routes beyond health, reconciliation columns on `source_records` (all Phase 3/4 per PRD non-goals).
