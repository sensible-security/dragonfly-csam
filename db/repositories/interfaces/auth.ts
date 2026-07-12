// Auth domain contracts (auth PRD §2, §4, §5 — Prompt 5.1). Structural enums,
// not CIS taxonomy: users hold the three human roles; `connector` is the
// principal type of an API key, never a user row (PRD Assumption 4). Each
// `as const` array is the TypeScript source of truth; the CHECK lists in
// db/migrations/0003_auth.sql must stay byte-identical (enum-parity test).
import type { AuditContext, Page, PageRequest } from "./common.ts";

export const USER_ROLES = [
  "admin",
  "analyst",
  "read_only",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = [
  "active",
  "disabled",
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const API_KEY_STATUSES = [
  "active",
  "revoked",
] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

// The resolved caller, set on ctx.state.identity by the auth middleware.
// The two credential channels are non-interchangeable (PRD Assumption 11).
export type AuthIdentity =
  | { kind: "user"; userId: string; username: string; role: UserRole }
  | { kind: "connector"; apiKeyId: string; sourceName: string };

// passwordHash is deliberately absent: the domain User is safe to serialize
// into audit snapshots and API responses. Only IUserRepository's credential
// lookup exposes the hash, and only to the identity provider.
export interface User {
  id: string;
  username: string; // normalized lowercase at the service boundary
  displayName: string;
  role: UserRole;
  status: UserStatus;
  identityProvider: string; // 'local' today; SSO providers later
  createdAt: string;
  updatedAt: string;
}

export interface CreateUser {
  username: string;
  displayName: string;
  role: UserRole;
  passwordHash: string | null; // null for SSO-provisioned users
  identityProvider?: string; // defaults to 'local'
}

export interface UpdateUser {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  passwordHash?: string; // password reset
}

export interface Session {
  id: string; // audit entity_id for login/logout — never the token
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateSession {
  tokenHash: string; // sha256 hex; the bearer token itself is never stored
  userId: string;
  expiresAt: string;
}

export interface ApiKey {
  id: string;
  name: string; // doubles as the ingest source name (provenance/actor)
  status: ApiKeyStatus;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface CreateApiKey {
  name: string;
  keyHash: string; // sha256 hex
}

export interface IUserRepository {
  create(input: CreateUser, ctx: AuditContext): Promise<User>;
  getById(id: string): Promise<User | null>;
  getByUsername(username: string): Promise<User | null>;
  // Credential lookup for the identity provider only: the hash never travels
  // further than the password verifier.
  getPasswordHash(userId: string): Promise<string | null>;
  list(page: PageRequest): Promise<Page<User>>;
  count(): Promise<number>; // bootstrap guard (PRD Assumption 7)
  // Disabling a user also deletes their sessions (same transaction) so
  // revocation is immediate (PRD §3 matrix note).
  update(id: string, patch: UpdateUser, ctx: AuditContext): Promise<User>;
}

export interface ISessionRepository {
  // Audited as entity_type 'session', action 'create' (PRD Assumption 9).
  create(input: CreateSession, ctx: AuditContext): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  // Audited as action 'delete'. No-op (null) when the token is unknown.
  deleteByTokenHash(
    tokenHash: string,
    ctx: AuditContext,
  ): Promise<Session | null>;
  deleteExpired(now: string): Promise<number>; // lazy harvest, not audited
}

export interface IApiKeyRepository {
  create(input: CreateApiKey, ctx: AuditContext): Promise<ApiKey>;
  getById(id: string): Promise<ApiKey | null>;
  findActiveByKeyHash(keyHash: string): Promise<ApiKey | null>;
  list(page: PageRequest): Promise<Page<ApiKey>>;
  revoke(id: string, ctx: AuditContext): Promise<ApiKey>;
  touchLastUsed(id: string, at: string): Promise<void>; // best-effort, not audited
}
