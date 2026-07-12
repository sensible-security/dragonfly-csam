// AuthService (auth PRD §5 — Prompt 5.1). Sessions, API keys, and the user
// admin surface, built on repository interfaces only. Credential verification
// is delegated to an injected IdentityProvider — the ONE swap point for the
// future Entra ID SSO roadmap item; session issuance, roles, RBAC, and audit
// wiring never change with the provider.
import type {
  ApiKey,
  AuditContext,
  AuthIdentity,
  IApiKeyRepository,
  ISessionRepository,
  IUserRepository,
  Page,
  PageRequest,
  UpdateUser,
  User,
  UserRole,
  UserStatus,
} from "../db/repositories/interfaces/mod.ts";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  MIN_PASSWORD_LENGTH,
  type PasswordHasher,
  Pbkdf2PasswordHasher,
} from "./password.ts";

// Credential verification — the only thing an SSO provider replaces (PRD
// Assumption 2). Returns null for unknown user, wrong password, disabled
// user, or a user owned by a different provider — indistinguishable to
// callers, uniform in cost (dummy KDF run on the misses).
export interface IdentityProvider {
  readonly id: string;
  verifyPassword(username: string, password: string): Promise<User | null>;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export class LocalIdentityProvider implements IdentityProvider {
  readonly id = "local";

  constructor(
    private readonly users: IUserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async verifyPassword(
    username: string,
    password: string,
  ): Promise<User | null> {
    const user = await this.users.getByUsername(normalizeUsername(username));
    const hash = user && user.status === "active" &&
        user.identityProvider === this.id
      ? await this.users.getPasswordHash(user.id)
      : null;
    if (!user || !hash) {
      // Burn a full KDF run so misses cost the same as hits (timing defense).
      await this.hasher.verify(password, await this.hasher.dummyEncoded());
      return null;
    }
    return (await this.hasher.verify(password, hash)) ? user : null;
  }
}

export interface LoginSuccess {
  token: string; // opaque bearer; only its SHA-256 is ever stored
  user: User;
  expiresAt: string;
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  role: UserRole;
  password: string;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  password?: string; // admin password reset
}

export interface AuthService {
  login(
    username: string,
    password: string,
    meta: { sourceAddress?: string },
  ): Promise<LoginSuccess | null>;
  logout(token: string, meta: { sourceAddress?: string }): Promise<void>;
  resolveSession(token: string): Promise<AuthIdentity | null>;
  resolveApiKey(key: string): Promise<AuthIdentity | null>;
  createApiKey(
    input: { name: string },
    ctx: AuditContext,
  ): Promise<{ apiKey: ApiKey; secret: string }>;
  revokeApiKey(id: string, ctx: AuditContext): Promise<ApiKey>;
  listApiKeys(page: PageRequest): Promise<Page<ApiKey>>;
  createUser(input: CreateUserInput, ctx: AuditContext): Promise<User>;
  updateUser(
    id: string,
    patch: UpdateUserInput,
    ctx: AuditContext,
  ): Promise<User>;
  getUser(id: string): Promise<User | null>;
  listUsers(page: PageRequest): Promise<Page<User>>;
  // First-boot admin seeding (PRD Assumption 7): creates an admin from
  // DRAGONFLY_ADMIN_USERNAME/PASSWORD when the users table is empty.
  bootstrapAdminFromEnv(): Promise<User | null>;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h (PRD Assumption 3)
const API_KEY_PREFIX = "dfk_";
// last_used_at is coarse "is this key live?" telemetry, not audited. Writing
// it on every ingest request would cost a table write per push; a minute of
// resolution is plenty, so we skip the write when the stamp is recent.
const LAST_USED_THROTTLE_MS = 60_000;

function sessionTtlFromEnv(): number {
  const hours = Number(Deno.env.get("DRAGONFLY_SESSION_TTL_HOURS"));
  return Number.isFinite(hours) && hours > 0
    ? hours * 60 * 60 * 1000
    : DEFAULT_SESSION_TTL_MS;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface AuthServiceDeps {
  users: IUserRepository;
  sessions: ISessionRepository;
  apiKeys: IApiKeyRepository;
  hasher?: PasswordHasher;
  provider?: IdentityProvider; // defaults to local username/password
  sessionTtlMs?: number;
}

export class DefaultAuthService implements AuthService {
  private readonly users: IUserRepository;
  private readonly sessions: ISessionRepository;
  private readonly apiKeys: IApiKeyRepository;
  private readonly hasher: PasswordHasher;
  private readonly provider: IdentityProvider;
  private readonly sessionTtlMs: number;

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users;
    this.sessions = deps.sessions;
    this.apiKeys = deps.apiKeys;
    this.hasher = deps.hasher ??
      new Pbkdf2PasswordHasher(DEFAULT_PBKDF2_ITERATIONS);
    this.provider = deps.provider ??
      new LocalIdentityProvider(this.users, this.hasher);
    this.sessionTtlMs = deps.sessionTtlMs ?? sessionTtlFromEnv();
  }

  async login(
    username: string,
    password: string,
    meta: { sourceAddress?: string },
  ): Promise<LoginSuccess | null> {
    const user = await this.provider.verifyPassword(username, password);
    if (!user) return null;

    // Lazy harvest keeps the table from accumulating dead rows (Assumption 3).
    await this.sessions.deleteExpired(new Date().toISOString());

    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    await this.sessions.create({
      tokenHash: await sha256Hex(token),
      userId: user.id,
      expiresAt,
    }, {
      actorType: "user",
      actorId: user.username,
      sourceAddress: meta.sourceAddress,
    });
    return { token, user, expiresAt };
  }

  async logout(
    token: string,
    meta: { sourceAddress?: string },
  ): Promise<void> {
    const tokenHash = await sha256Hex(token);
    const session = await this.sessions.findByTokenHash(tokenHash);
    if (!session) return; // unknown/expired token: nothing to revoke
    const user = await this.users.getById(session.userId);
    await this.sessions.deleteByTokenHash(tokenHash, {
      actorType: "user",
      actorId: user?.username ?? session.userId,
      sourceAddress: meta.sourceAddress,
    });
  }

  async resolveSession(token: string): Promise<AuthIdentity | null> {
    if (!token) return null;
    const session = await this.sessions.findByTokenHash(await sha256Hex(token));
    if (!session) return null;
    const now = new Date().toISOString();
    if (session.expiresAt <= now) {
      await this.sessions.deleteExpired(now);
      return null;
    }
    const user = await this.users.getById(session.userId);
    if (!user || user.status !== "active") return null;
    return {
      kind: "user",
      userId: user.id,
      username: user.username,
      role: user.role,
    };
  }

  async resolveApiKey(key: string): Promise<AuthIdentity | null> {
    if (!key) return null;
    const apiKey = await this.apiKeys.findActiveByKeyHash(await sha256Hex(key));
    if (!apiKey) return null;
    const now = Date.now();
    const last = apiKey.lastUsedAt ? Date.parse(apiKey.lastUsedAt) : 0;
    if (now - last > LAST_USED_THROTTLE_MS) {
      await this.apiKeys.touchLastUsed(apiKey.id, new Date(now).toISOString());
    }
    return { kind: "connector", apiKeyId: apiKey.id, sourceName: apiKey.name };
  }

  async createApiKey(
    input: { name: string },
    ctx: AuditContext,
  ): Promise<{ apiKey: ApiKey; secret: string }> {
    const secret = API_KEY_PREFIX + randomToken();
    const apiKey = await this.apiKeys.create({
      name: input.name.trim(),
      keyHash: await sha256Hex(secret),
    }, ctx);
    return { apiKey, secret }; // the secret's only appearance (PRD §6)
  }

  revokeApiKey(id: string, ctx: AuditContext): Promise<ApiKey> {
    return this.apiKeys.revoke(id, ctx);
  }

  listApiKeys(page: PageRequest): Promise<Page<ApiKey>> {
    return this.apiKeys.list(page);
  }

  async createUser(input: CreateUserInput, ctx: AuditContext): Promise<User> {
    return await this.users.create({
      username: normalizeUsername(input.username),
      displayName: input.displayName,
      role: input.role,
      passwordHash: await this.hasher.hash(input.password),
    }, ctx);
  }

  async updateUser(
    id: string,
    patch: UpdateUserInput,
    ctx: AuditContext,
  ): Promise<User> {
    const repoPatch: UpdateUser = {
      displayName: patch.displayName,
      role: patch.role,
      status: patch.status,
    };
    if (patch.password !== undefined) {
      repoPatch.passwordHash = await this.hasher.hash(patch.password);
    }
    return await this.users.update(id, repoPatch, ctx);
  }

  getUser(id: string): Promise<User | null> {
    return this.users.getById(id);
  }

  listUsers(page: PageRequest): Promise<Page<User>> {
    return this.users.list(page);
  }

  async bootstrapAdminFromEnv(): Promise<User | null> {
    if (await this.users.count() > 0) return null;
    const username = Deno.env.get("DRAGONFLY_ADMIN_USERNAME");
    const password = Deno.env.get("DRAGONFLY_ADMIN_PASSWORD");
    if (!username || !password) {
      console.warn(
        "dragonfly: users table is empty and DRAGONFLY_ADMIN_USERNAME/" +
          "DRAGONFLY_ADMIN_PASSWORD are not set — no one can sign in",
      );
      return null;
    }
    // The first admin is the highest-privilege account; hold it to the same
    // password policy the admin API enforces on every other user rather than
    // letting a weak env value through the service back door.
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.warn(
        `dragonfly: DRAGONFLY_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} ` +
          "characters — initial admin not created",
      );
      return null;
    }
    return await this.createUser({
      username,
      displayName: username,
      role: "admin",
      password,
    }, { actorType: "system", actorId: "bootstrap" });
  }
}
