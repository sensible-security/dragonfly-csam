# ROADMAP — Dragonfly CSAM

**Status:** APPROVED — Phase 6 gate approved 2026-07-12 **Source prompt:**
DEVELOPMENT_PLAN.md, Prompt 6.2 **Compliance scope:** extends CIS Controls v8.1
Control 1 (Safeguard 1.4) and Control 2 (Safeguards 2.5–2.7) to completion, then
Controls 3, 4, 5/6, 7, 15 · NIST CSF 2.0 ID.AM (built) → PR/DE/GV (design-for)
**Authority:** AGENTS.md §9 (Roadmap Awareness — the schema/architecture hooks
this backlog cashes in), §4.1 (layering), §4.2 (connector pipeline — every
source item is _config of the existing abstraction_, not new pipeline code)
**Builds on:** shipped Phases 0–5 —
[PRD-core-data-model.md](./docs/specs/PRD-core-data-model.md),
[PRD-ingestion-pipeline.md](./docs/specs/PRD-ingestion-pipeline.md),
[PRD-authentication.md](./docs/specs/PRD-authentication.md),
[PRD-api-read-access.md](./docs/specs/PRD-api-read-access.md),
[DEPLOYMENT.md](./DEPLOYMENT.md)

---

## Assumptions I'm Making

These shape the prioritization and the per-item acceptance criteria. Correct any
before this backlog drives planning.

1. **Every asset-source item (1, 3–7) is built by _configuring the existing
   `Connector` abstraction_, not by extending the pipeline.** The ingestion PRD
   §10 proved DHCP is addable as "a connector object + a `sources` row + an API
   key." The same is asserted for every cloud connector here: if any of them
   forces an edit to `IngestionService`, `ReconciliationService`, the match-key
   order (§6.1), or the review-queue engine, that is a **spec defect to
   surface**, not a licence to modify the engine. Consequence: connector items
   are individually small and independently shippable — hence they cluster near
   the top of the backlog.
2. **Match-key order and field precedence are frozen (AGENTS.md §8 — "ask before
   changing").** New connectors _contribute_ existing match keys
   (`cloud_instance_id` > `hardware_serial` > `mac_address` > `hostname_domain`;
   `software_identity`) and slot into the precedence ranks already defined
   (manual 100 / authoritative-cloud 80 / scanner 50 / csv 40 / dhcp 20). No
   item below silently reorders them; any proposed rank for a new source is
   called out for approval in that item.
3. **Cloud connectors are `pull` + `incremental` where the source API supports
   delta/change queries.** Push endpoints (`/api/ingest/{sourceType}`) remain
   for scanners/DHCP; pull connectors run on a scheduler (a scheduling mechanism
   — cron in-container or an external trigger hitting a
   `POST /api/connectors/{id}/run` endpoint — is itself a small roadmap
   sub-item, called out in item 3's criteria and shared thereafter).
4. **New control _modules_ (items 9–12) cash in the §9 "reserved" hooks and
   require additive migrations only.** `0001`/`0002` are forbidden to edit
   (AGENTS.md §8); every module ships its own numbered forward-only migration,
   its own repository interface(s) + Turso impl under `db/repositories/`, and
   its own enum-parity tests — the same shape as every prior phase.
5. **"Prioritized" means the four tiers below, not a hard commitment to
   intra-tier order.** Within a tier, items are independent and can be sequenced
   by team capacity or customer pull. The tier boundaries _are_ the commitment:
   don't start a Tier N+1 item while a Tier N item that unblocks it is open
   (dependencies are named per item).
6. **No new external dependency is assumed approved.** Cloud SDKs (MS Graph,
   AWS, Google) each trigger AGENTS.md §8 "ask before adding dependencies." Each
   connector item's criteria include an explicit dependency decision (vendor SDK
   vs. hand-rolled `fetch` against the REST API — the latter is preferred to
   keep the connector a pure normalizer with no driver surface).

---

## Prioritization Framework

The product mandate (AGENTS.md §1) is **Controls 1 & 2, complete**, on an
architecture that extends to 3, 4, 5/6, 7, 15 without refactoring. That orders
the backlog:

| Tier   | Theme                                                | Why here                                                                                                                                                         | Items                                                                                   |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **T1** | Finish the core mandate + highest-leverage real data | Closes the last two safeguards of Controls 1 & 2 and turns on automatic device inventory for the typical Microsoft-centric estate. Cheapest, highest-value work. | 1 (DHCP), 2 (allowlist export), 3 (Entra), 4 (Intune)                                   |
| **T2** | Cloud breadth + first control extension beyond 1 & 2 | Broadens automated coverage to the other major clouds; item 8 lights up the CPE hook already carried on every software row.                                      | 5 (Azure RG), 6 (AWS Config), 7 (Google), 8 (CVE)                                       |
| **T3** | New control modules on reserved hooks                | Each cashes in a §9 "reserved" schema hook to open a new CIS control. Larger (schema + module + UI) but non-blocking to the connector work.                      | 9 (DataClasses/C3), 10 (ConfigState/C4), 11 (Accounts/C5-6), 12 (Svc-provider risk/C15) |
| **T4** | Platform & architecture proofs                       | Validate the two headline architectural promises — DB-agnosticism and a swappable identity provider — once the feature surface justifies them.                   | 13 (Postgres backend), 14 (Entra SSO)                                                   |

### Connector spec template (reused from ingestion PRD §10)

Every connector item (1, 3, 4, 5, 6, 7) is specified with the same four fields
plus its capability descriptor, so each is a drop-in:

- **Source API** — the endpoint/product the connector reads.
- **Auth mechanism** — how the connector authenticates _to the source_ (distinct
  from how it authenticates _into Dragonfly_, which is always an ingest API key
  or an in-process scheduled run).
- **Canonical field mapping** — source fields →
  `DeviceObservation`/`SoftwareObservation` (ingestion PRD §3).
- **Match keys contributed** — which of the ordered reconciliation keys (§6.1)
  this source can populate, and the proposed source `precedence` rank.

---

## Tier 1 — Finish the Core Mandate

### 1. DHCP log connector — Safeguard 1.4

Completes Control 1. Already **designed-for** in ingestion PRD §10
(config-only); this item is the build.

- **Source API:** DHCP lease/log stream — ISC `dhcpd` leases, Kea lease DB/hook,
  or Windows DHCP server audit logs. Delivery is push: a log-shipper POSTs lease
  events.
- **Auth mechanism (into Dragonfly):** connector API key on
  `POST /api/ingest/dhcp_log` (existing ingest channel; no new auth surface).
- **Canonical field mapping:** lease event `{ mac, ip, hostname, leaseTime }` →
  `DeviceObservation` with `matchKeys.macAddresses = [mac]`,
  `matchKeys.hostname`, and
  `interfaces[].ips[] = [{ address: ip, observedAt: leaseTime }]`. No `fields`
  beyond identity (DHCP knows no criticality → `providesRequiredFields: false`).
- **Match keys contributed:** `mac_address`, `hostname_domain`. **Precedence
  20** (already reserved).

**Acceptance criteria**

- A `DhcpLogConnector` object registered in the registry; **zero** edits to
  `IngestionService`/`ReconciliationService`/match-key order (Assumption 1) —
  proven by the architecture-boundary test still green.
- MAC matches an existing device → IP history + `last_seen` refresh, no spurious
  `updated_at`/audit noise (ingestion PRD §6.4).
- MAC matches nothing → **`new_asset` review-queue item** (the "unknown device
  took a lease" Safeguard 1.4 signal), never a silent create.
- Weak-key-only match with conflicting hostname → `review_queue`, never
  auto-merge (reuses the gate-case rule).
- Fixtures under `tests/fixtures/` include a malformed lease line → quarantined
  with a per-row error, batch not rejected wholesale.

### 2. Allowlist authoring + hash/library/script export — Safeguards 2.5–2.7

Completes Control 2. **Scope note (AGENTS.md §5):** Dragonfly _authors and
exports_ allowlists; endpoint protection platforms _enforce_ them — we never
claim enforcement.

- **New schema (additive migration):** cryptographic-hash + signature fields on
  tracked software artifacts — binaries (2.5), libraries `.dll/.so/.ocx` (2.6),
  scripts `.ps1/.py` (2.7) — hung off the existing `software` catalog via a
  `software_artifacts` child table (`software_id` FK, `artifact_type`
  CHECK(`binary|library|script`), `path`, `hash_algo`, `hash_value`,
  `signature_subject`, `signature_valid`, provenance columns). New enum is
  CHECK+TS parity-tested.
- **Export formats:** downloadable allowlist artifacts keyed to the
  authorization state already on `software`
  (`authorized|unauthorized|exception_documented`): (a) hash allowlist (CSV/JSON
  of authorized hashes), (b) library allowlist, (c) script allowlist — each
  filtered to `authorization_status = 'authorized'`.

**Acceptance criteria**

- Artifact hash/signature fields ingestible via the existing pipeline (scanner
  JSON `software` observations gain optional artifact records) — no engine
  change.
- `GET /api/software/allowlist/{binaries|libraries|scripts}` returns only
  authorized entries as a structured export; API-key-readable (matches
  PRD-api-read-access read surface — add the prefix to the allowlist array + a
  test row).
- An unsupported/EOL-flagged item cannot silently enter an export; the
  documented-exception workflow (`exception_documented`) is the only path for a
  non-authorized item to appear, and it is audited.
- UI: an allowlist authoring view (server-rendered table + an island for the
  authorize/exception toggle, reusing `AssetStatusToggle` patterns).

### 3. Microsoft Entra connector

Highest-leverage automated device inventory for the typical estate.

- **Source API:** Microsoft Graph `GET /v1.0/devices` (directory device objects)
  and `/v1.0/users` (for owner enrichment); delta query `GET /devices/delta` for
  incremental runs.
- **Auth mechanism (to source):** OAuth2 **client-credentials** flow against an
  app registration (tenant-scoped `client_id` + secret **or** certificate),
  application permission `Device.Read.All`. Token acquired via `fetch` to the
  Entra token endpoint — no vendor SDK (Assumption 6).
- **Canonical field mapping:** Entra device → `DeviceObservation`:
  `deviceId`/`azureADDeviceId` (GUID) → `matchKeys.cloudInstanceId`;
  `displayName` → `matchKeys.hostname` + `fields` hostname;
  `operatingSystem`/`operatingSystemVersion` → a linked `SoftwareObservation`
  (`software_type: operating_system`); `deviceClass`/`enterpriseAssetType`
  inferred as `enterprise_asset`/`end_user_device` where determinable, else left
  unset. Cloud provenance → `environment: cloud`.
  `providesRequiredFields: false` (Entra has no business criticality → no-match
  → review for enrichment).
- **Match keys contributed:** `cloud_instance_id` (strong), `hostname_domain`
  (weak). **Proposed precedence 80** (authoritative-cloud rank — flagged for
  approval per Assumption 2).

**Acceptance criteria**

- Registered `pull` + `incremental` connector; delta token persisted per-source
  so re-runs fetch only changes.
- **Scheduling sub-item (shared, first delivered here):** a
  `POST /api/connectors/{id}/run` admin-only trigger + a documented
  external-scheduler pattern (cron in-container or host trigger) — no in-process
  job framework. Later pull connectors reuse it.
- Client secret/cert sourced from env/secret store, **never** logged, never
  committed (AGENTS.md §8).
- Unique `cloud_instance_id` match → auto-merge; no match → `new_asset` review
  item.
- Connector directory stays SQL/driver-free (boundary test); the token-fetch
  `fetch` call is the only I/O and lives in the connector, not a service.

### 4. Intune connector

The richest device source (contributes a **strong** key — serial — plus
installed software).

- **Source API:** Microsoft Graph `GET /v1.0/deviceManagement/managedDevices`;
  per-device `…/managedDevices/{id}/detectedApps` for installed software
  (Safeguard 2.1 automated feed).
- **Auth mechanism (to source):** OAuth2 client-credentials, application
  permission `DeviceManagementManagedDevices.Read.All`. Same token pattern as
  item 3 (share the Entra token helper).
- **Canonical field mapping:** managed device → `DeviceObservation`:
  `serialNumber` → `matchKeys.hardwareSerial` (**strong**); `azureADDeviceId` →
  `matchKeys.cloudInstanceId`; `wiFiMacAddress`/`ethernetMacAddress` →
  `matchKeys.macAddresses` + `interfaces[]`; `deviceName` → `hostname`;
  `manufacturer`/`model`, `complianceState`, `osVersion` → `fields` / linked OS
  `SoftwareObservation`. `detectedApps[]` → `SoftwareObservation` per app with
  `installedOnExternalId` = the device's `externalId`.
  `providesRequiredFields: false`.
- **Match keys contributed:** `hardware_serial` (strong), `cloud_instance_id`
  (strong), `mac_address`, `hostname_domain`. **Proposed precedence 80.**

**Acceptance criteria**

- Serial-keyed auto-merge with Entra-sourced records for the same physical
  device (cross-source correlation through reconciliation, ingestion PRD
  Assumption 6) — an integration test proves one physical laptop from Entra +
  Intune reconciles to **one** canonical device, not two.
- Detected apps stage as software observations and link via
  `recordInstallation`; unresolved host → deferred to the same review item
  (ingestion PRD Assumption 7), never dropped.
- Incremental fetch (managed-device delta) + shared scheduler from item 3.
- No engine/match-key edits (Assumption 1); boundary test green.

---

## Tier 2 — Cloud Breadth + First Extension

### 5. Azure Resource Graph connector

- **Source API:** Azure Resource Graph
  `POST providers/Microsoft.ResourceGraph/resources` (KQL over ARM), querying
  `Microsoft.Compute/virtualMachines`,
  `microsoft.compute/virtualmachinescalesets`, etc.
- **Auth mechanism (to source):** OAuth2 client-credentials or **managed
  identity** against ARM (`https://management.azure.com/.default`), directory
  **Reader** role on the target subscriptions/management group.
- **Canonical field mapping:** resource → `DeviceObservation`: `properties.vmId`
  → `matchKeys.cloudInstanceId`; `name` → `hostname`; `location`,
  `properties.hardwareProfile`, tags → `fields`; `environment: cloud`,
  `enterpriseAssetType: server` (default for VMs). NICs from
  `Microsoft.Network/networkInterfaces` join → `interfaces[]` (MAC + private
  IP). `providesRequiredFields: false`.
- **Match keys contributed:** `cloud_instance_id` (strong), `mac_address`.
  **Proposed precedence 80.**

**Acceptance criteria:** `pull`+`incremental` (KQL time/`changeTime` filter);
paginated result cursor handled; unique vmId → auto-merge; shared scheduler +
boundary test; secret handling per item 3.

### 6. AWS Config connector

- **Source API:** AWS Config `SelectAggregateResourceConfig` /
  `SelectResourceConfig` (SQL over recorded resource configs), resource type
  `AWS::EC2::Instance` (+ ENIs, `AWS::SSM::ManagedInstanceInventory` for
  installed software later).
- **Auth mechanism (to source):** IAM via cross-account **AssumeRole**
  (preferred) or scoped access keys; permissions
  `config:SelectAggregateResourceConfig`, `config:SelectResourceConfig`. SigV4
  request signing (hand-rolled signer or minimal signing helper — dependency
  decision flagged).
- **Canonical field mapping:** instance config → `DeviceObservation`:
  `resourceId` (`i-…`) → `matchKeys.cloudInstanceId`;
  `configuration.privateDnsName` → `hostname`; ENI MACs →
  `matchKeys.macAddresses` + `interfaces[]`; tags → `fields` (owner/department
  from tag conventions, documented); `environment: cloud`,
  `enterpriseAssetType: server`. `providesRequiredFields: false`.
- **Match keys contributed:** `cloud_instance_id` (strong), `mac_address`,
  `hostname_domain`. **Proposed precedence 80.**

**Acceptance criteria:** SigV4 signing unit-tested against a known AWS fixture;
aggregator multi-account pagination handled; unique instance-id → auto-merge;
scheduler + boundary test; credentials never logged.

### 7. Google Workspace + Cloud Asset Inventory connectors (two connectors, one item)

- **7a — Google Workspace (endpoints/mobile):**
  - **Source API:** Admin SDK Directory API — `chromeosdevices.list`,
    `mobiledevices.list`.
  - **Auth:** service account with **domain-wide delegation**, read-only scopes
    (`…admin.directory.device.chromeos.readonly`, `…mobile.readonly`);
    JWT-bearer OAuth2.
  - **Mapping:** `serialNumber` → `matchKeys.hardwareSerial` (**strong**);
    `macAddress`/`ethernetMacAddress` → `matchKeys.macAddresses`;
    `annotatedAssetId`/`deviceId` → external id;
    `enterpriseAssetType: end_user_device`. `providesRequiredFields: false`.
  - **Match keys:** `hardware_serial` (strong), `mac_address`.
    **Precedence 80.**
- **7b — Google Cloud Asset Inventory:**
  - **Source API:** Cloud Asset Inventory `cloudasset.googleapis.com`
    (`assets.list` / `exportAssets`), compute instance assets.
  - **Auth:** service account, IAM `roles/cloudasset.viewer`; OAuth2 access
    token.
  - **Mapping:** compute instance `id` → `matchKeys.cloudInstanceId`; `name` →
    `hostname`; NICs → `interfaces[]`; `environment: cloud`,
    `enterpriseAssetType: server`.
  - **Match keys:** `cloud_instance_id` (strong), `mac_address`.
    **Precedence 80.**

**Acceptance criteria:** two registered connectors sharing one Google-auth
helper; JWT/service-account key from secret store, never logged; each proven
config-only against the engine; boundary test green.

### 8. CVE ingestion binding to CPE strings — Control 7

Lights up the `software.cpe` hook carried on every software row since `0001`.
**Not a reconciliation source** — an enrichment feed keyed by CPE, so it does
**not** contribute match keys.

- **Source API:** NVD REST API 2.0 (`services.nvd.nist.gov/rest/json/cves/2.0`)
  filtered by `cpeName`; OSV.dev as an alternate/secondary.
- **Auth mechanism (to source):** NVD API key (header) for rate-limit headroom;
  OSV is unauthenticated.
- **New schema (additive migration):** `vulnerabilities` (`cve_id` PK,
  `cvss_score`, `severity` CHECK enum, `published`, `last_modified`,
  `summary`) + `software_vulnerabilities` join (`software_id` FK, `cve_id` FK,
  `matched_cpe`, `first_seen`, `last_seen`, provenance). Enum parity-tested.

**Acceptance criteria**

- A software row with a CPE gets matched CVEs; a row with no CPE is simply not
  enriched (no error).
- `GET /api/software/{id}/vulnerabilities` + a `GET /api/vulnerabilities` list,
  API-key-readable (add to read allowlist + test).
- Match is by CPE string only — no fuzzy guessing (untrusted-data discipline);
  ambiguous CPE → recorded, not auto-applied.
- Enrichment runs on the shared scheduler; feed failures degrade gracefully
  (stale `last_modified`, not a crash).
- Software EOL/unsupported flags (Safeguard 2.2) surface alongside CVE count on
  the software detail page (Control 7 ↔ Control 2 tie-in).

---

## Tier 3 — New Control Modules

### 9. DataClasses mapping — Control 3, Safeguard 3.2

Cashes in the §9 "Assets ↔ DataClasses many-to-many join reserved" hook.

- **Schema (additive):** `data_classes` (`id`, `name`, `sensitivity` CHECK enum
  e.g. `public|internal|confidential|restricted`, `description`) +
  `asset_data_classes` join (`asset_id`, `data_class_id`, provenance/actor,
  `created_at`). Seed the CIS/organizational data-classification set
  (documented, not invented).
- **Repository + service + API + UI:** `IDataClassRepository` (+Turso), a
  service, `GET/POST /api/data-classes` and asset-tagging endpoints, and an
  island to tag an asset with data classes on the detail page.

**Acceptance criteria:** many-to-many tag/untag is audited; sensitivity enum
CHECK+TS parity-tested; API-key-readable listing; the reserved join is filled
**without editing `0001`** (additive migration); asset detail page shows
data-class chips.

### 10. ConfigurationState drift linkage — Control 4

Cashes in the "Asset → ConfigurationState linkage point reserved" hook.

- **Schema (additive):** `configuration_baselines` (named expected states) +
  `asset_configuration_states` (`asset_id`, `baseline_id`, `observed_state_ref`,
  `drift` boolean/enum, `checked_at`, provenance). Ingested via the existing
  pipeline (a config-scanner `scanner_json`-style observation carries
  configuration facts).
- **Module:** repository + service + `GET /api/assets/{id}/configuration` + a
  drift indicator on asset detail and a dashboard KPI ("N assets drifted from
  baseline").

**Acceptance criteria:** config observations flow through the connector pipeline
(no direct writes); drift is computed from baseline vs. observed and audited on
change; enum parity-tested; additive migration only.

### 11. Accounts module expansion — Controls 5/6, Safeguard 5.1

Extends the existing `users` (auth) table toward an **account inventory**
(distinct from login identities).

- **Schema (additive):** an `accounts` inventory taxonomy per AGENTS.md §9 —
  `account_type` CHECK(`user|admin|service`), `principal_type`
  CHECK(`workforce|service_provider`), linkage to `assets` (account-on-asset)
  and `service_providers`. Kept separate from `users` (which are Dragonfly's own
  login identities); a `users` row _may_ reference an inventoried account.
- **Module:** repository + service + inventory API + UI (account list, filter by
  type, orphan/stale-account flags for Safeguard 5.1 groundwork).

**Acceptance criteria:** account taxonomy enums CHECK+TS parity-tested; accounts
ingestible via a connector (e.g. Entra/Workspace directory users, reusing items
3/7 auth) — **no direct writes**; audited CRUD; additive migration; does not
disturb the auth `users` table or session logic (AGENTS.md §8 auth-change
caution — surfaced explicitly).

### 12. Service provider risk workflows — Control 15

Extends the `service_providers` table (live since `0001`, NIST ID.AM-04).

- **Schema (additive):** risk fields on/around `service_providers` —
  `classification` CHECK enum (criticality tier), `data_classes_handled` (link
  to item 9's `data_classes`), `contract_ref`, `sla_ref`, `review_cadence`,
  `last_reviewed_at`, `next_review_due`, `risk_status` CHECK enum.
- **Module:** repository extension + service + API + a review workflow UI
  (providers due for review, overdue flags) and a dashboard KPI.

**Acceptance criteria:** review actions audited; cadence/overdue computed and
surfaced; ties to DataClasses (item 9) for "which providers touch restricted
data"; additive migration; enum parity-tested. (Depends on item 9 for the
data-class link — named per Assumption 5.)

---

## Tier 4 — Platform & Architecture Proofs

### 13. Second database backend — Postgres repository implementations (the agnosticism proof)

Validates AGENTS.md §4.1: "a future `PostgresDeviceRepository` must be addable
without editing any file outside `db/repositories/`."

- **Scope:** implement every shipped repository interface under a new
  `db/repositories/postgres/` directory against a Postgres client; a config
  switch in the composition root selects the backend; parity migrations
  translated from `db/migrations/` (or a Postgres migration set) — all **within
  `db/`**.

**Acceptance criteria**

- **Not a single file outside `db/repositories/` (plus the composition-root
  wiring + migrations under `db/`) changes** — proven by the diff and the
  existing architecture-boundary test.
- The **entire existing test suite** runs green against the Postgres backend
  (repositories are behavior-tested through their interfaces, so the suites are
  reused verbatim with a backend switch).
- CHECK-constraint/enum parity holds on Postgres (enums may become native
  `CHECK` or `ENUM` types — parity test adapts).
- Turso remains the default; Postgres is opt-in. Documented in DEPLOYMENT.md.
- Confirms the §4.1 containment promise: the pre-1.0 Turso risk (AGENTS.md §1
  stability note) is now demonstrably swappable.

### 14. Entra ID SSO — OIDC identity provider

Cashes in the auth "swap point": the `IdentityProvider` interface
(PRD-authentication §5) whose **only** job is credential verification.

- **Scope:** an `EntraIdentityProvider implements IdentityProvider` doing OIDC
  authorization-code + PKCE against Entra; session issuance, RBAC roles, API-key
  channel, audit-actor wiring all **unchanged**. Users may be SSO-provisioned
  (`password_hash NULL`, already allowed by schema).

**Acceptance criteria**

- **Only** an added `IdentityProvider` implementation + its wiring changes;
  `AuthService`, session handling, the guard, RBAC, and audit are untouched —
  proven by diff scope (matches PRD-authentication's "the ONLY thing an SSO
  provider replaces" claim).
- `local` password auth still works (providers coexist; provider selected
  per-user/config).
- OIDC secrets from the secret store, never logged; no PII (email/username) in
  logs (AGENTS.md §8).
- Login/logout still audited as `entity_type = 'session'` with the SSO-resolved
  identity; disabled/other-provider users are indistinguishable to callers
  (unchanged contract).
- Roadmap-adjacent (deferred, noted not built): MFA, login rate limiting,
  account lockout (PRD-authentication non-goals) ride alongside this item's
  planning.

---

## Backlog Summary

| #  | Item                              | Tier | Control/Safeguard    | Contributes match keys          | Depends on                          |
| -- | --------------------------------- | ---- | -------------------- | ------------------------------- | ----------------------------------- |
| 1  | DHCP log connector                | T1   | 1.4                  | mac, hostname+domain            | — (designed in ingestion §10)       |
| 2  | Allowlist authoring + export      | T1   | 2.5–2.7              | n/a (export)                    | —                                   |
| 3  | Microsoft Entra connector         | T1   | 1.1/2.1 (ID.AM)      | cloud-id, hostname+domain       | scheduler sub-item (delivered here) |
| 4  | Intune connector                  | T1   | 1.1/2.1              | serial, cloud-id, mac, hostname | 3 (shares Graph token + scheduler)  |
| 5  | Azure Resource Graph connector    | T2   | 1.1                  | cloud-id, mac                   | 3 (scheduler)                       |
| 6  | AWS Config connector              | T2   | 1.1                  | cloud-id, mac, hostname         | 3 (scheduler)                       |
| 7  | Google Workspace + CAI connectors | T2   | 1.1                  | serial, mac / cloud-id          | 3 (scheduler)                       |
| 8  | CVE ingestion (CPE binding)       | T2   | Control 7            | n/a (enrichment)                | 3 (scheduler)                       |
| 9  | DataClasses mapping               | T3   | Control 3 / 3.2      | n/a                             | —                                   |
| 10 | ConfigurationState drift          | T3   | Control 4            | n/a                             | —                                   |
| 11 | Accounts module expansion         | T3   | Controls 5/6 / 5.1   | n/a                             | 3 or 7 (directory ingest)           |
| 12 | Service provider risk workflows   | T3   | Control 15           | n/a                             | 9 (data-class link)                 |
| 13 | Postgres repository backend       | T4   | (architecture proof) | n/a                             | —                                   |
| 14 | Entra ID SSO                      | T4   | (auth swap proof)    | n/a                             | —                                   |

---

## Cross-Cutting Acceptance Criteria (apply to every item)

Non-negotiable, inherited from AGENTS.md — restated so no item's own criteria
have to:

1. **Repository Pattern intact** — no SQL/driver imports outside
   `db/repositories/turso/` (and, for item 13, `…/postgres/`); the
   architecture-boundary test stays green.
2. **Connector pipeline never bypassed** — no connector or module writes
   canonical/inventory tables directly (AGENTS.md §4.2); all source data flows
   Source→Normalize→Stage→Reconcile→Merge.
3. **Taxonomy enforced in both layers** — every new enum is a TS `as const`
   array **and** a SQL CHECK, byte-identical, covered by the enum-parity
   harness.
4. **All external input Zod-validated at the boundary**; untrusted payloads
   stored as data, never interpreted (AGENTS.md §2.7).
5. **Every mutation audited** via the repository `AuditContext`; no secrets or
   PII in logs; API keys grant read-only, sessions gate humans (unchanged
   channel separation).
6. **Additive, forward-only migrations only** — `0001`/`0002` are never edited;
   match-key order and precedence ranks change only with explicit approval.
7. **TDD** — failing test first; `deno task check && deno task test` green
   before any slice is accepted (AGENTS.md §7, Working Rhythm).
