# PRD: Dragonfly CSAM — Authentication & Authorization (Phase 5)

**Status:** DRAFT — proceeding directly to /build per Prompt 5.1 ("/spec then /build"); assumptions below are surfaced for correction at the Phase 5 gate
**Source prompt:** DEVELOPMENT_PLAN.md, Prompt 5.1
**Compliance scope:** AGENTS.md §8 ("all routes require authentication except health checks; secure session handling; no PII in logs") · CIS Control 8 (audit actor identity) · groundwork for Controls 5/6 (account & access management, §9 roadmap)
**Authority:** AGENTS.md §4.1 (layering), §4.4 (audit), §8 (boundaries: "ask before … modifying auth/audit code" — this PRD *is* the sanctioned auth work)
**Builds on:** [PRD-core-data-model.md](./PRD-core-data-model.md), [PRD-ingestion-pipeline.md](./PRD-ingestion-pipeline.md) (Assumption 9 explicitly deferred real ingest auth to this prompt), [PRD-api-and-ui-routes.md](./PRD-api-and-ui-routes.md)

---

## Assumptions I'm Making

Decisions the source prompt leaves open. Each is proceeded with as written; correct any at the gate.

1. **Local username/password is the Phase 5 identity provider.** Passwords are hashed with **PBKDF2-HMAC-SHA256 via WebCrypto** (210,000 iterations, 16-byte random salt, 32-byte derived key) — the only NIST-blessed KDF available in Deno with **zero new dependencies** (AGENTS.md §8: ask before adding deps; argon2/bcrypt would need one). The encoding `pbkdf2$<iterations>$<salt b64>$<hash b64>` self-describes iterations so they can be raised later without invalidating old hashes.
2. **The swappable unit is the `IdentityProvider` interface — session issuance, roles, and audit wiring stay local forever.** `DefaultAuthService` delegates *credential verification* to an injected `IdentityProvider` (`local` today). Future Entra ID SSO = a second provider implementation plus an OIDC callback route that calls the same `AuthService` session-issuance path. Nothing about sessions, roles, RBAC, or audit changes when SSO lands; `users.identity_provider` and a nullable `password_hash` are the schema hooks.
3. **Sessions are DB-backed opaque tokens, not JWTs.** 256-bit random token, base64url, delivered in an `HttpOnly` cookie; the DB stores only the **SHA-256 hash** of the token (a leaked DB file cannot mint sessions). Absolute TTL, default 8 h (`DRAGONFLY_SESSION_TTL_HOURS`), no sliding renewal — re-login on expiry. Expired rows are deleted lazily (on login and on lookup miss). Server-side revocation (logout, user disable) must be immediate — that rules out stateless JWTs.
4. **`connector` is not a user role — it is the principal type of an API key.** Humans get `admin | analyst | read_only` (users table CHECK). API keys are always connector principals; a fourth enum value `connector` exists in the shared `UserRole`-adjacent `AUTH_ROLES` list only where a single role vocabulary is needed (audit/permission matrix). No user row can hold role `connector`.
5. **RBAC is coarse, route-class level** (method + path prefix), not per-entity ACLs. The matrix in §3 is the whole model. Per-object permissions are a non-goal.
6. **API keys move to the database, replacing the Phase 3 env stub** (`DRAGONFLY_INGEST_KEYS` and `services/ingest_auth.ts` are deleted). A key is `dfk_<43 base64url chars>` (256-bit), shown **once** at creation, stored as SHA-256 hash, bound to a unique `name` that doubles as the ingest **source name** (provenance + audit actor), revocable, `last_used_at` tracked best-effort.
7. **Bootstrap:** at container startup, if the users table is **empty** and `DRAGONFLY_ADMIN_USERNAME`/`DRAGONFLY_ADMIN_PASSWORD` are set, an admin user is created (audited, `actor_type = 'system'`, `actor_id = 'bootstrap'`). Empty table + no env → a warning is logged (no secrets) and only `/api/health` + `/login` are reachable. This avoids both a hardcoded default credential and an unauthenticated setup wizard.
8. **User and API-key management is API-only this phase** (`/api/admin/*`, admin role). A management UI is roadmap (it would be a Phase 4-style build slice, and Prompt 5.1 doesn't ask for it). Users are **disabled, never deleted** — audit rows reference actor identities forever.
9. **Login/logout are audited as `entity_type = 'session'`** with the existing `create`/`delete` audit actions — no audit-action enum change, no `audit_log` table rebuild. The audit `entity_id` is the session row id, never the token. **Failed logins are not persisted** and usernames are never logged (no PII in logs, no log-flooding channel); login rate limiting is listed for /review (5.2) consideration as a roadmap item.
10. **CSRF defense is SameSite=Lax plus an Origin check** on every mutating (non-GET/HEAD/OPTIONS) session-authenticated request: if an `Origin` header is present and does not match the request host, reject 403. No synchronizer-token machinery — islands do same-origin `fetch`, forms are same-origin posts, and API-key requests (no cookies) are exempt.
11. **Ingest endpoints accept API keys only; sessions never authenticate ingest.** *(Amended by [PRD-api-read-access.md](./PRD-api-read-access.md), Prompt 5.3:)* an API key additionally authenticates **GET/HEAD on the JSON read APIs** (`/api/devices`, `/api/software`, `/api/source-records`, `/api/audit-log`, `/api/review-queue`), so SIEM/GRC tooling has a programmatic read credential (AGENTS.md §4.3). The channels stay non-interchangeable everywhere else: a key grants no mutation, admin, or UI access anywhere (403 `api_key_forbidden`), and a session cookie is still not a credential for ingest. Note the original parenthetical ("a leaked scanner key cannot read inventory") no longer holds — a leaked key is now a read-scope credential, mitigated by revocation and `last_used_at`.
12. **`/api/health` remains the only unauthenticated route** besides `/login` (the door itself) and static assets (`staticFiles()` runs before auth, as it already does).

---

## 1. Objective

Every request to Dragonfly resolves to an authenticated identity before any handler runs; every audit row names that identity. Analysts sign in with a session; scanners authenticate with revocable API keys; roles gate who can read, write, and administer. The identity provider is a swap point, not a rewrite point, for the Entra ID SSO roadmap item.

**Success looks like:** the placeholder `actorId: "system"` in `routes/(_shared)/context.ts` is gone; an unauthenticated `curl` to any API answers 401 and any page redirects to `/login`; a `read_only` session cannot mutate anything; a revoked API key stops working immediately; the audit-log viewer shows real usernames and source names.

### Non-goals (this spec)

- Entra ID SSO / OIDC (roadmap #14) — designed-for via `IdentityProvider` (§5), not built.
- User/API-key management **UI**, self-service password change/reset, MFA, login rate limiting, account lockout → roadmap / 5.2 review findings.
- Per-entity authorization, row-level security, tenant separation.
- ~~API keys for general (non-ingest) API access by third-party tooling — roadmap; the SIEM/GRC read path stays session-gated for now.~~ *Delivered in Prompt 5.3 — see [PRD-api-read-access.md](./PRD-api-read-access.md).*

---

## 2. Identity Model

```ts
export type AuthIdentity =
  | { kind: "user"; userId: string; username: string; role: UserRole } // admin | analyst | read_only
  | { kind: "connector"; apiKeyId: string; sourceName: string };
```

Set on `ctx.state.identity` by the auth middleware; `undefined` only on the open routes (§3). Audit wiring (§7) maps it to `AuditContext` — `user`/username or `connector`/sourceName. No handler ever re-derives identity from headers.

## 3. Roles & Permission Matrix (RBAC, route-class level)

| Route class | admin | analyst | read_only | connector (API key) | anonymous |
|---|---|---|---|---|---|
| `/api/health` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/login` (GET+POST), static assets | ✓ (redirects home if signed in) | ✓ | ✓ | — | ✓ |
| `/logout` (POST) | ✓ | ✓ | ✓ | 403 | → /login |
| UI pages (GET) | ✓ | ✓ | ✓ | 403 | 303 → /login?next= |
| Read APIs (GET/HEAD `/api/**`) | ✓ | ✓ | ✓ | ✓ on the 5.3 allowlist (devices, software, source-records, audit-log, review-queue); 403 elsewhere | 401 |
| Mutating APIs (POST/PATCH/PUT/DELETE `/api/**` except below) | ✓ | ✓ | 403 | 403 | 401 |
| `/api/admin/**` (users, api-keys) | ✓ | 403 | 403 | 403 | 401 |
| `POST /api/ingest/*` | — (401: key required) | — | — | ✓ | 401 |

*(Connector-column 403s are `api_key_forbidden`, issued without resolving the key — [PRD-api-read-access.md](./PRD-api-read-access.md) §2.)*

- `read_only` browses every page and reads every API; any mutating method answers `403 { error: { code: "forbidden" } }`.
- Sessions on `/api/ingest/*` and API keys anywhere else are **not** credentials (Assumption 11) → 401.
- Disabled users and revoked keys fail resolution → 401 (sessions of a disabled user die on next request, and disabling deletes the user's sessions outright).

## 4. Data Model — `db/migrations/0003_auth.sql` (additive; 0001/0002 frozen)

```sql
users (
  id TEXT PK,                    -- uuid
  username TEXT NOT NULL UNIQUE, -- normalized lowercase at the service boundary
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','analyst','read_only')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  password_hash TEXT,            -- NULL for future SSO-provisioned users
  identity_provider TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
sessions (
  id TEXT PK,                    -- uuid; the audit entity_id for login/logout
  token_hash TEXT NOT NULL UNIQUE,  -- sha256 hex of the bearer token; token itself never stored
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
)  + INDEX idx_sessions_user (user_id)
api_keys (
  id TEXT PK,
  name TEXT NOT NULL UNIQUE,     -- doubles as ingest source name (provenance/actor)
  key_hash TEXT NOT NULL UNIQUE, -- sha256 hex
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT
)
```

Enum arrays (`USER_ROLES`, `USER_STATUSES`, `API_KEY_STATUSES`) live in `db/repositories/interfaces/auth.ts`; SQL CHECK lists must stay byte-identical (extends the existing enum-parity test suite).

## 5. Service Layer (the swap point)

```ts
// Credential verification — the ONLY thing an SSO provider replaces.
export interface IdentityProvider {
  readonly id: string; // 'local'
  verifyPassword(username: string, password: string): Promise<User | null>;
  // returns null for unknown user, wrong password, disabled user, or a
  // user belonging to a different provider — indistinguishable to callers.
}

export interface AuthService {
  // sessions
  login(username: string, password: string, meta: { sourceAddress?: string }):
    Promise<{ token: string; user: User; expiresAt: string } | null>;   // audits session create
  logout(token: string, meta: { sourceAddress?: string }): Promise<void>; // audits session delete
  resolveSession(token: string): Promise<AuthIdentity | null>;
  // api keys
  resolveApiKey(key: string): Promise<AuthIdentity | null>;
  createApiKey(input: { name: string }, ctx: AuditContext): Promise<{ apiKey: ApiKey; secret: string }>;
  revokeApiKey(id: string, ctx: AuditContext): Promise<ApiKey>;
  listApiKeys(page: PageRequest): Promise<Page<ApiKey>>;
  // users (admin surface; hashing stays in here, never in routes)
  createUser(input: CreateUserInput, ctx: AuditContext): Promise<User>;
  updateUser(id: string, patch: UpdateUserInput, ctx: AuditContext): Promise<User>; // role/status/display_name/password
  listUsers(page: PageRequest): Promise<Page<User>>;
  getUser(id: string): Promise<User | null>;
  // boot
  bootstrapAdminFromEnv(): Promise<void>; // Assumption 7
}
```

`LocalIdentityProvider` verifies against `IUserRepository` + the PBKDF2 hasher, with a **constant-cost dummy verification** on unknown usernames (no timing oracle for user enumeration). Repositories behind it: `IUserRepository`, `ISessionRepository`, `IApiKeyRepository` — interfaces in `db/repositories/interfaces/auth.ts`, Turso implementations in `db/repositories/turso/`, audited writes inside transactions exactly like every existing repository. `AuthService` joins the `Services` bundle in the composition root.

## 6. HTTP Surface

**Middleware** (registered in `main.ts` after the container middleware, before `fsRoutes()`): pure decision function `guardRequest(req, auth)` in `services/http_auth.ts` → `{ identity } | { response }`, unit-testable without Fresh. Order: open-route check → credential resolution (cookie for everything, `X-API-Key`/`Bearer` only under `/api/ingest/`) → RBAC matrix (§3) → CSRF origin check (Assumption 10).

**Cookie:** `dragonfly_session`; `HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>`; `Secure` when the request is https or `DRAGONFLY_COOKIE_SECURE=1`. Cleared (Max-Age=0) on logout and on any request bearing an invalid/expired token.

**Routes:**
- `GET /login` — Beer CSS form (AGENTS.md §6 floating labels), server-rendered, no island. Signed-in users are redirected home. `POST /login` — form-encoded, Zod-validated; success → Set-Cookie + `303` to a validated `next` (must start `/`, not `//` — open-redirect guard); failure → re-render with a generic error (which of username/password failed is never disclosed).
- `POST /logout` — deletes the session, clears the cookie, `303 /login`. (POST, not GET: state-changing, CSRF-guarded.)
- `GET|POST /api/admin/users`, `GET|PATCH /api/admin/users/:id` — create (username, displayName, role, password), patch (role, status, displayName, password reset). Zod-validated, structured errors, admin-only via the matrix.
- `GET|POST /api/admin/api-keys`, `POST /api/admin/api-keys/:id/revoke` — create returns `{ apiKey, secret }` **once**; list never includes hashes.
- `routes/api/ingest/[sourceType].ts` — drops its in-handler key check; identity arrives from middleware as `{ kind: "connector" }`.
- `_app.tsx` — renders the nav shell only when `state.identity` is present (login page gets a bare shell); app bar gains the signed-in username/role and a logout form button.

## 7. Audit Wiring

`auditContextFrom(req, identity)` replaces the Phase 4 placeholder: `user` identity → `{ actorType: 'user', actorId: username }`; `connector` → `{ actorType: 'connector', actorId: sourceName }`. All 12 handler call sites updated mechanically; exported testable handler functions keep taking `AuditContext` unchanged. Session create/delete, user create/update, key create/revoke each write audit rows in-transaction (existing repository invariant). Secrets (passwords, hashes, tokens, keys) never appear in audit before/after JSON — user snapshots exclude `password_hash`; session/key snapshots exclude hashes.

## 8. Threat Notes (in scope → mitigation)

Stolen DB file → only hashes of tokens/keys/passwords stored. Session fixation → token minted server-side at login only, never accepted from the client. CSRF → Lax + Origin check. Open redirect → `next` validation. User enumeration → uniform login error + dummy-hash timing defense; 401 body identical for missing vs unknown vs revoked credentials. Log leakage → no usernames/tokens in server logs; audit rows carry usernames by design (that is their job — the audit log is itself session-gated data).

## 9. Test Plan (TDD per slice)

1. `password_test.ts` — hash/verify roundtrip, wrong password, tampered encoding, iteration self-description.
2. `auth_repositories_test.ts` — users/sessions/api_keys CRUD + audit rows + CHECK-constraint rejections + enum parity; expired-session harvest; disable-user kills sessions.
3. `auth_service_test.ts` — login happy path; wrong password / unknown user / disabled user indistinguishable; expiry honored; logout revokes; API key create→resolve→revoke lifecycle; bootstrap idempotence (empty vs non-empty table, env unset).
4. `http_auth_test.ts` — the full §3 matrix as table-driven cases, plus CSRF origin rejection, cookie parsing, key-channel separation.
5. `auth_routes_test.ts` — login/logout handlers (Set-Cookie, 303, `next` guard, generic failure), admin endpoints (validation, one-time secret, no-hash listings).
6. Existing `ingest_test.ts` updated to DB-backed keys; architecture test must stay green (new files respect layering by construction).

**Gate criteria (5.1 slice of the Phase 5 gate):** `deno task check && deno task test` green; manual walkthrough: sign in, browse, mutate as analyst, get 403 as read_only, ingest with a created key, revoke it, see every action in the audit log under the real identity.
