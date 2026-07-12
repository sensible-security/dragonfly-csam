# PRD: Programmatic API Read Access (Phase 5.3)

**Status:** DRAFT — proceeding directly to /build per Prompt 5.3 ("/spec then /build"); assumptions surfaced for correction at the Phase 5 gate
**Source prompt:** DEVELOPMENT_PLAN.md, Prompt 5.3
**Compliance scope:** AGENTS.md §4.3 (API-first: SIEM/GRC/dashboard tooling must be able to query the inventory — NIST CSF GV support) · §8 boundaries
**Amends:** [PRD-authentication.md](./PRD-authentication.md) — Assumption 11, the §3 permission matrix, and the "API keys for general API access" non-goal

---

## 1. Problem

The 5.2 review surfaced a §4.3 gap: API keys authenticate only `/api/ingest/`, and the sole session issuer is the form-encoded login page. External tooling therefore has **no programmatic credential** for the read APIs — a SIEM cannot `GET /api/devices` without scripting a browser login flow.

## 2. Decision

A connector API key (`X-API-Key` or `Authorization: Bearer`) additionally authenticates **read-only (GET/HEAD) access** to the JSON read APIs:

```
/api/devices/**   /api/software/**   /api/source-records/**
/api/audit-log/** /api/review-queue/**
```

(segment-aware prefixes: `/api/devices` and `/api/devices/<id>/...` match; `/api/devicesx` does not).

Channel separation stays explicit and bidirectional:

- **An API key grants no write access anywhere.** Every mutating method, `/api/admin/**`, and every UI route refuses it.
- **A session cookie is still not a credential for `/api/ingest/**`** (unchanged, PRD-authentication Assumption 11's second half).

### Refusal semantics

A request that presents an API key outside its allowed surface (ingest, or GET/HEAD on the read prefixes) is answered **`403 { error: { code: "api_key_forbidden" } }` without resolving the key**. Rationale:

- Explicit over silent: falling through to the session channel would answer a mis-configured SIEM with `401 unauthenticated` (confusing — it *did* send a credential) or, on UI routes, an HTML redirect to `/login`.
- Refusing before resolution means the response never confirms whether the presented key is valid (no validity oracle) and costs no DB lookup.

An **invalid/revoked** key on an *allowed* read path gets `401 invalid_api_key` — identical to ingest.

## 3. Assumptions I'm Making

1. **The allowlist is exactly the five read surfaces named in Prompt 5.3.** `/api/import/csv` (a mutation), `/api/ingestion-batches/*/errors` (tied to the CSV-import UI workflow), `/login`, `/logout`, and `/api/admin/**` stay off it. Extending the list later is a one-array change plus a test row.
2. **GET and HEAD only.** OPTIONS is not on the key channel (CORS preflights carry no custom headers anyway).
3. **If a request carries both a session cookie and an API key, the key channel wins.** Browsers never send `X-API-Key`; a dual-credential request is programmatic, and deterministic channel selection beats guessing intent. Consequence: key + cookie on a mutation → `403 api_key_forbidden`.
4. **Reads are not audited** (unchanged, matches session reads). `last_used_at` best-effort tracking in `resolveApiKey` covers "is this key alive" observability.
5. **No new scopes/roles.** A connector key is read-everything-listed or nothing; per-key scoping (e.g., audit-log-only keys) is roadmap. The audit log is deliberately readable: SIEM export of audit events is a primary GV consumer.

## 4. Doc Reconciliation (the other half of the prompt)

Code, PRD, and AGENTS.md disagreed on the exemption list. Reconciled statement, applied to AGENTS.md §8:

> All routes require authentication except the health check, the login page itself, and static assets. Sessions authenticate humans (UI + full API per role); API keys authenticate connectors (ingest, plus read-only GET/HEAD on the JSON read APIs) and never grant mutation, admin, or UI access.

PRD-authentication.md edits: Assumption 11 amended (key channel now covers reads), §3 matrix connector column updated, the "API keys for general (non-ingest) API access — roadmap" non-goal marked delivered here.

## 5. Test Plan (TDD)

Extend `tests/services/http_auth_test.ts`:

1. Key `GET /api/devices` → ok, resolves `{ kind: "connector", sourceName }`; same for the other four prefixes and for HEAD.
2. Key `POST /api/devices` → 403 `api_key_forbidden`.
3. Key on `/api/admin/users` (GET) and `/api/admin/api-keys` (POST) → 403 `api_key_forbidden`.
4. Key on UI route `GET /devices` → 403 `api_key_forbidden`.
5. Key on non-allowlisted API read (`/api/ingestion-batches/x/errors`) → 403.
6. Invalid and revoked keys on `/api/devices` → 401 `invalid_api_key`.
7. Key + cookie on a mutation → 403 (Assumption 3).
8. Existing channel-separation cases stay green: session on ingest → 401 `api_key_required`; prefix-confusion guard (`/api/devicesx` is not key-readable).

**Gate criteria (5.3 slice):** `deno task check && deno task test` green; a created API key can `curl` every listed read API and is refused everywhere else.
