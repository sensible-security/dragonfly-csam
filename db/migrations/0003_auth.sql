-- 0003_auth.sql — Dragonfly CSAM authentication schema (additive)
-- PRD: docs/specs/PRD-authentication.md §4 · AGENTS.md §8 (all routes authed)
-- Forward-only: 0001/0002 are frozen. Enum CHECK value lists must stay
-- byte-identical to the arrays in db/repositories/interfaces/auth.ts
-- (parity test enforces this).

-- ---------------------------------------------------------------------------
-- users — human principals. Roles are the three human roles only; 'connector'
-- is an API-key principal type, never a user (PRD Assumption 4). password_hash
-- is NULL for future SSO-provisioned users; identity_provider is the Entra ID
-- hook (PRD Assumption 2). Users are disabled, never deleted, so audit actor
-- references stay resolvable forever (PRD Assumption 8).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('admin', 'analyst', 'read_only')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  password_hash TEXT,
  identity_provider TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- sessions — DB-backed opaque tokens (PRD Assumption 3). Only the SHA-256 of
-- the bearer token is stored; session.id (not the token) is the audit
-- entity_id for login/logout. Absolute expiry; expired rows harvested lazily.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- api_keys — connector principals (PRD Assumption 6). Replaces the Phase 3
-- DRAGONFLY_INGEST_KEYS env stub. name doubles as the ingest source name;
-- the key itself is shown once at creation and stored only as SHA-256.
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
