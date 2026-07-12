// AuthService tests (auth PRD §9.3): login/logout/session lifecycle over real
// repositories on a temp DB, uniform failure for unknown/wrong/disabled,
// API-key lifecycle, and bootstrap idempotence.
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { withTempDb } from "../repositories/helpers.ts";
import type { DatabaseConnection } from "@/db/repositories/turso/connection.ts";
import { TursoUserRepository } from "@/db/repositories/turso/user_repository.ts";
import { TursoSessionRepository } from "@/db/repositories/turso/session_repository.ts";
import { TursoApiKeyRepository } from "@/db/repositories/turso/api_key_repository.ts";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import { Pbkdf2PasswordHasher } from "@/services/password.ts";
import {
  type AuthService,
  DefaultAuthService,
} from "@/services/auth_service.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";

const CTX: AuditContext = { actorType: "user", actorId: "admin" };
const PAGE = { limit: 20, offset: 0 };

function build(db: DatabaseConnection, opts: { ttlMs?: number } = {}): {
  auth: AuthService;
  audit: TursoAuditLogRepository;
} {
  const users = new TursoUserRepository(db);
  const auth = new DefaultAuthService({
    users,
    sessions: new TursoSessionRepository(db),
    apiKeys: new TursoApiKeyRepository(db),
    hasher: new Pbkdf2PasswordHasher(1_000),
    sessionTtlMs: opts.ttlMs,
  });
  return { auth, audit: new TursoAuditLogRepository(db) };
}

Deno.test("login issues a session token that resolves to a user identity", async () => {
  await withTempDb(async (db) => {
    const { auth, audit } = build(db);
    const user = await auth.createUser({
      username: "Ariel", // normalized to lowercase
      displayName: "Ariel Analyst",
      role: "analyst",
      password: "correct horse battery staple",
    }, CTX);
    assertEquals(user.username, "ariel");

    const result = await auth.login("ARIEL", "correct horse battery staple", {
      sourceAddress: "10.1.1.1",
    });
    assert(result, "login should succeed");
    assert(result.token.length >= 40, "opaque high-entropy token");

    const identity = await auth.resolveSession(result.token);
    assertEquals(identity, {
      kind: "user",
      userId: user.id,
      username: "ariel",
      role: "analyst",
    });

    // Login audited as session create with the user as actor.
    const entries = await audit.query({ entityType: "session" }, PAGE);
    assertEquals(entries.total, 1);
    assertEquals(entries.items[0].action, "create");
    assertEquals(entries.items[0].actorId, "ariel");
    assertEquals(entries.items[0].sourceAddress, "10.1.1.1");
    assert(
      !entries.items[0].afterJson?.includes(result.token),
      "token must never reach the audit log",
    );
  });
});

Deno.test("unknown user, wrong password, and disabled user all fail identically", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    await auth.createUser({
      username: "morgan",
      displayName: "Morgan",
      role: "read_only",
      password: "a long valid password",
    }, CTX);

    assertEquals(await auth.login("nobody", "whatever password", {}), null);
    assertEquals(
      await auth.login("morgan", "wrong password entirely", {}),
      null,
    );

    const user = await auth.getUser(
      (await auth.login("morgan", "a long valid password", {}))!.user.id,
    );
    await auth.updateUser(user!.id, { status: "disabled" }, CTX);
    assertEquals(await auth.login("morgan", "a long valid password", {}), null);
  });
});

Deno.test("disabling a user invalidates their already-issued sessions", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    const user = await auth.createUser({
      username: "leaver",
      displayName: "Leaver",
      role: "analyst",
      password: "a long valid password",
    }, CTX);
    const login = await auth.login("leaver", "a long valid password", {});
    assert(await auth.resolveSession(login!.token));

    await auth.updateUser(user.id, { status: "disabled" }, CTX);
    assertEquals(await auth.resolveSession(login!.token), null);
  });
});

Deno.test("resetting a password revokes live sessions and marks the audit entry", async () => {
  await withTempDb(async (db) => {
    const { auth, audit } = build(db);
    const user = await auth.createUser({
      username: "reset",
      displayName: "Reset",
      role: "analyst",
      password: "a long valid password",
    }, CTX);
    const login = await auth.login("reset", "a long valid password", {});
    assert(await auth.resolveSession(login!.token));

    // A password reset (compromise response) must take effect immediately.
    await auth.updateUser(
      user.id,
      { password: "an entirely new password" },
      CTX,
    );
    assertEquals(await auth.resolveSession(login!.token), null);
    assert(await auth.login("reset", "an entirely new password", {}));

    // The audit trail records that a credential changed — without the hash.
    const updates = await audit.query(
      { entityType: "user", action: "update" },
      PAGE,
    );
    assert(
      updates.items[0].afterJson?.includes('"passwordChanged":true'),
      "audit after-snapshot flags the credential change",
    );
    assert(
      !updates.items[0].afterJson?.toLowerCase().includes("pbkdf2"),
      "the password hash never reaches the audit log",
    );
  });
});

Deno.test("an API key can be revoked and reissued under the same source name", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    const first = await auth.createApiKey({ name: "nessus-dc1" }, CTX);

    // A second ACTIVE key with the same name is rejected.
    await assertRejects(() => auth.createApiKey({ name: "nessus-dc1" }, CTX));

    // Revoking frees the name so a rotated key keeps the same provenance.
    await auth.revokeApiKey(first.apiKey.id, CTX);
    const second = await auth.createApiKey({ name: "nessus-dc1" }, CTX);
    assertNotEquals(second.secret, first.secret);
    assert(await auth.resolveApiKey(second.secret), "rotated key works");
    assertEquals(await auth.resolveApiKey(first.secret), null, "old key dead");
  });
});

Deno.test("bootstrapAdminFromEnv refuses a password below the minimum length", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    Deno.env.set("DRAGONFLY_ADMIN_USERNAME", "root");
    Deno.env.set("DRAGONFLY_ADMIN_PASSWORD", "tooshort"); // 8 chars < 12
    try {
      assertEquals(await auth.bootstrapAdminFromEnv(), null);
      assertEquals((await auth.listUsers(PAGE)).total, 0);
    } finally {
      Deno.env.delete("DRAGONFLY_ADMIN_USERNAME");
      Deno.env.delete("DRAGONFLY_ADMIN_PASSWORD");
    }
  });
});

Deno.test("sessions expire by TTL and logout revokes immediately", async () => {
  await withTempDb(async (db) => {
    const { auth, audit } = build(db, { ttlMs: -1_000 }); // born expired
    await auth.createUser({
      username: "shortlived",
      displayName: "Short",
      role: "analyst",
      password: "a long valid password",
    }, CTX);
    const expired = await auth.login("shortlived", "a long valid password", {});
    assert(expired);
    assertEquals(await auth.resolveSession(expired.token), null);

    const { auth: auth2 } = build(db); // normal TTL over the same DB
    const live = await auth2.login("shortlived", "a long valid password", {});
    assert(await auth2.resolveSession(live!.token));
    await auth2.logout(live!.token, { sourceAddress: "10.0.0.5" });
    assertEquals(await auth2.resolveSession(live!.token), null);

    const deletions = await audit.query(
      { entityType: "session", action: "delete" },
      PAGE,
    );
    assertEquals(deletions.total, 1);
    assertEquals(deletions.items[0].actorId, "shortlived");
  });
});

Deno.test("resolveSession rejects garbage and foreign tokens", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    assertEquals(await auth.resolveSession(""), null);
    assertEquals(await auth.resolveSession("not-a-real-token"), null);
  });
});

Deno.test("api key lifecycle: create returns the secret once, resolve, revoke", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    const { apiKey, secret } = await auth.createApiKey(
      { name: "nessus-dc1" },
      CTX,
    );
    assert(secret.startsWith("dfk_"), "key format dfk_<random>");
    assert(!JSON.stringify(apiKey).includes(secret.slice(4)));

    const identity = await auth.resolveApiKey(secret);
    assertEquals(identity, {
      kind: "connector",
      apiKeyId: apiKey.id,
      sourceName: "nessus-dc1",
    });
    // A session token is not an API key and vice versa.
    assertEquals(await auth.resolveApiKey("dfk_definitely-not-issued"), null);

    await auth.revokeApiKey(apiKey.id, CTX);
    assertEquals(await auth.resolveApiKey(secret), null);

    const page = await auth.listApiKeys(PAGE);
    assertEquals(page.items[0].status, "revoked");
    assert(page.items[0].lastUsedAt, "resolution stamps last_used_at");
  });
});

Deno.test("two logins issue distinct tokens; each resolves independently", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    await auth.createUser({
      username: "dual",
      displayName: "Dual",
      role: "admin",
      password: "a long valid password",
    }, CTX);
    const a = await auth.login("dual", "a long valid password", {});
    const b = await auth.login("dual", "a long valid password", {});
    assertNotEquals(a!.token, b!.token);
    await auth.logout(a!.token, {});
    assertEquals(await auth.resolveSession(a!.token), null);
    assert(await auth.resolveSession(b!.token));
  });
});

Deno.test("bootstrapAdminFromEnv creates the first admin only on an empty table", async () => {
  await withTempDb(async (db) => {
    const { auth, audit } = build(db);
    Deno.env.set("DRAGONFLY_ADMIN_USERNAME", "root");
    Deno.env.set("DRAGONFLY_ADMIN_PASSWORD", "an initial admin password");
    try {
      const created = await auth.bootstrapAdminFromEnv();
      assertEquals(created?.username, "root");
      assertEquals(created?.role, "admin");

      // Idempotent: second boot is a no-op.
      assertEquals(await auth.bootstrapAdminFromEnv(), null);
      assertEquals((await auth.listUsers(PAGE)).total, 1);

      assert(await auth.login("root", "an initial admin password", {}));

      const entries = await audit.query({ entityType: "user" }, PAGE);
      assertEquals(entries.items[0].actorType, "system");
      assertEquals(entries.items[0].actorId, "bootstrap");
    } finally {
      Deno.env.delete("DRAGONFLY_ADMIN_USERNAME");
      Deno.env.delete("DRAGONFLY_ADMIN_PASSWORD");
    }
  });
});

Deno.test("bootstrapAdminFromEnv is a no-op without env configuration", async () => {
  await withTempDb(async (db) => {
    const { auth } = build(db);
    Deno.env.delete("DRAGONFLY_ADMIN_USERNAME");
    Deno.env.delete("DRAGONFLY_ADMIN_PASSWORD");
    assertEquals(await auth.bootstrapAdminFromEnv(), null);
    assertEquals((await auth.listUsers(PAGE)).total, 0);
  });
});
