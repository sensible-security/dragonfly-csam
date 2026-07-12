// Auth repository tests (auth PRD §9.2): users/sessions/api_keys CRUD with
// in-transaction audit rows, CHECK-constraint rejections, enum parity with
// 0003_auth.sql, expired-session harvest, and disable-kills-sessions.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { withTempDb } from "./helpers.ts";
import { TursoUserRepository } from "@/db/repositories/turso/user_repository.ts";
import { TursoSessionRepository } from "@/db/repositories/turso/session_repository.ts";
import { TursoApiKeyRepository } from "@/db/repositories/turso/api_key_repository.ts";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import type { DatabaseConnection } from "@/db/repositories/turso/connection.ts";
import {
  API_KEY_STATUSES,
  type AuditContext,
  DuplicateAssetError,
  NotFoundError,
  TaxonomyViolationError,
  USER_ROLES,
  USER_STATUSES,
} from "@/db/repositories/interfaces/mod.ts";

const CTX: AuditContext = {
  actorType: "user",
  actorId: "admin",
  sourceAddress: "10.0.0.9",
};

const PAGE = { limit: 20, offset: 0 };
const HASH = "pbkdf2$1000$c2FsdA==$aGFzaA=="; // stored opaquely; never verified here

function repos(db: DatabaseConnection) {
  return {
    users: new TursoUserRepository(db),
    sessions: new TursoSessionRepository(db),
    apiKeys: new TursoApiKeyRepository(db),
    audit: new TursoAuditLogRepository(db),
  };
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// --- users -----------------------------------------------------------------

Deno.test("user create persists, audits, and never exposes the password hash", async () => {
  await withTempDb(async (db) => {
    const { users, audit } = repos(db);
    const user = await users.create({
      username: "ariel",
      displayName: "Ariel Analyst",
      role: "analyst",
      passwordHash: HASH,
    }, CTX);

    assertEquals(user.username, "ariel");
    assertEquals(user.role, "analyst");
    assertEquals(user.status, "active");
    assertEquals(user.identityProvider, "local");
    assert(!("passwordHash" in user), "domain User must not carry the hash");

    assertEquals(await users.getPasswordHash(user.id), HASH);

    const entries = await audit.query(
      { entityType: "user", entityId: user.id },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assertEquals(entries.items[0].action, "create");
    assertEquals(entries.items[0].actorId, "admin");
    assert(
      !entries.items[0].afterJson?.includes(HASH),
      "audit snapshot must not contain the password hash",
    );
  });
});

Deno.test("user usernames are unique; roles are CHECK-constrained", async () => {
  await withTempDb(async (db) => {
    const { users } = repos(db);
    await users.create({
      username: "dup",
      displayName: "First",
      role: "read_only",
      passwordHash: HASH,
    }, CTX);
    await assertRejects(
      () =>
        users.create({
          username: "dup",
          displayName: "Second",
          role: "read_only",
          passwordHash: HASH,
        }, CTX),
      DuplicateAssetError,
    );
    await assertRejects(
      () =>
        users.create({
          username: "conn",
          displayName: "No connector users",
          // deno-lint-ignore no-explicit-any
          role: "connector" as any, // PRD Assumption 4: never a user role
          passwordHash: HASH,
        }, CTX),
      TaxonomyViolationError,
    );
  });
});

Deno.test("user update patches role/status/password and audits before/after", async () => {
  await withTempDb(async (db) => {
    const { users, audit } = repos(db);
    const user = await users.create({
      username: "morgan",
      displayName: "Morgan",
      role: "read_only",
      passwordHash: HASH,
    }, CTX);

    const updated = await users.update(user.id, {
      role: "analyst",
      displayName: "Morgan A.",
      passwordHash: "pbkdf2$1000$bmV3$bmV3",
    }, CTX);
    assertEquals(updated.role, "analyst");
    assertEquals(updated.displayName, "Morgan A.");
    assertEquals(await users.getPasswordHash(user.id), "pbkdf2$1000$bmV3$bmV3");

    const entries = await audit.query(
      { entityType: "user", entityId: user.id, action: "update" },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assert(entries.items[0].beforeJson?.includes("read_only"));
    assert(entries.items[0].afterJson?.includes("analyst"));

    await assertRejects(
      () => users.update(crypto.randomUUID(), { role: "admin" }, CTX),
      NotFoundError,
    );
  });
});

Deno.test("disabling a user deletes their sessions in the same operation", async () => {
  await withTempDb(async (db) => {
    const { users, sessions } = repos(db);
    const user = await users.create({
      username: "leaver",
      displayName: "Leaver",
      role: "analyst",
      passwordHash: HASH,
    }, CTX);
    await sessions.create({
      tokenHash: "th-1",
      userId: user.id,
      expiresAt: futureIso(60_000),
    }, CTX);

    await users.update(user.id, { status: "disabled" }, CTX);
    assertEquals(await sessions.findByTokenHash("th-1"), null);
  });
});

Deno.test("user list pages and count supports the bootstrap guard", async () => {
  await withTempDb(async (db) => {
    const { users } = repos(db);
    assertEquals(await users.count(), 0);
    for (const name of ["a", "b", "c"]) {
      await users.create({
        username: name,
        displayName: name,
        role: "read_only",
        passwordHash: HASH,
      }, CTX);
    }
    assertEquals(await users.count(), 3);
    const page = await users.list({ limit: 2, offset: 0 });
    assertEquals(page.total, 3);
    assertEquals(page.items.length, 2);
    assertEquals(page.items[0].username, "a");
  });
});

// --- sessions ----------------------------------------------------------------

Deno.test("session create/find/delete lifecycle with audit rows", async () => {
  await withTempDb(async (db) => {
    const { users, sessions, audit } = repos(db);
    const user = await users.create({
      username: "sess",
      displayName: "Sess",
      role: "admin",
      passwordHash: HASH,
    }, CTX);

    const session = await sessions.create({
      tokenHash: "th-abc",
      userId: user.id,
      expiresAt: futureIso(60_000),
    }, { actorType: "user", actorId: "sess" });

    const found = await sessions.findByTokenHash("th-abc");
    assertEquals(found?.id, session.id);
    assertEquals(found?.userId, user.id);

    const deleted = await sessions.deleteByTokenHash("th-abc", {
      actorType: "user",
      actorId: "sess",
    });
    assertEquals(deleted?.id, session.id);
    assertEquals(await sessions.findByTokenHash("th-abc"), null);
    // Unknown token: silent no-op, no audit row.
    assertEquals(await sessions.deleteByTokenHash("nope", CTX), null);

    const entries = await audit.query(
      { entityType: "session", entityId: session.id },
      PAGE,
    );
    assertEquals(entries.total, 2);
    const actions = entries.items.map((e) => e.action).sort();
    assertEquals(actions, ["create", "delete"]);
    for (const entry of entries.items) {
      assert(
        !entry.beforeJson?.includes("th-abc") &&
          !entry.afterJson?.includes("th-abc"),
        "audit snapshots must not contain the token hash",
      );
    }
  });
});

Deno.test("deleteExpired harvests only past-expiry sessions", async () => {
  await withTempDb(async (db) => {
    const { users, sessions } = repos(db);
    const user = await users.create({
      username: "exp",
      displayName: "Exp",
      role: "analyst",
      passwordHash: HASH,
    }, CTX);
    await sessions.create({
      tokenHash: "th-old",
      userId: user.id,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }, CTX);
    await sessions.create({
      tokenHash: "th-live",
      userId: user.id,
      expiresAt: futureIso(60_000),
    }, CTX);

    const harvested = await sessions.deleteExpired(new Date().toISOString());
    assertEquals(harvested, 1);
    assertEquals(await sessions.findByTokenHash("th-old"), null);
    assert(await sessions.findByTokenHash("th-live"));
  });
});

// --- api keys ----------------------------------------------------------------

Deno.test("api key create/resolve/revoke lifecycle with audit rows", async () => {
  await withTempDb(async (db) => {
    const { apiKeys, audit } = repos(db);
    const key = await apiKeys.create(
      { name: "nessus-dc1", keyHash: "kh-1" },
      CTX,
    );
    assertEquals(key.name, "nessus-dc1");
    assertEquals(key.status, "active");
    assert(!("keyHash" in key), "domain ApiKey must not carry the hash");

    const active = await apiKeys.findActiveByKeyHash("kh-1");
    assertEquals(active?.id, key.id);

    await apiKeys.touchLastUsed(key.id, new Date().toISOString());
    const touched = await apiKeys.getById(key.id);
    assert(touched?.lastUsedAt, "last_used_at should be stamped");

    const revoked = await apiKeys.revoke(key.id, CTX);
    assertEquals(revoked.status, "revoked");
    assert(revoked.revokedAt);
    assertEquals(await apiKeys.findActiveByKeyHash("kh-1"), null);
    await assertRejects(
      () => apiKeys.revoke(crypto.randomUUID(), CTX),
      NotFoundError,
    );

    const entries = await audit.query(
      { entityType: "api_key", entityId: key.id },
      PAGE,
    );
    assertEquals(entries.total, 2);
    for (const entry of entries.items) {
      assert(
        !entry.beforeJson?.includes("kh-1") &&
          !entry.afterJson?.includes("kh-1"),
        "audit snapshots must not contain the key hash",
      );
    }
  });
});

Deno.test("api key names are unique; list never includes hashes", async () => {
  await withTempDb(async (db) => {
    const { apiKeys } = repos(db);
    await apiKeys.create({ name: "scanner", keyHash: "kh-a" }, CTX);
    await assertRejects(
      () => apiKeys.create({ name: "scanner", keyHash: "kh-b" }, CTX),
      DuplicateAssetError,
    );
    const page = await apiKeys.list(PAGE);
    assertEquals(page.total, 1);
    assert(!JSON.stringify(page.items).includes("kh-a"));
  });
});

// --- enum parity (auth PRD §4) ----------------------------------------------

Deno.test("0003_auth.sql CHECK lists match the TypeScript enum arrays", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../db/migrations/0003_auth.sql", import.meta.url),
  );
  const expectCheck = (column: string, values: readonly string[]) => {
    const list = values.map((v) => `'${v}'`).join(", ");
    assert(
      sql.includes(`CHECK (${column} IN (${list}))`),
      `0003_auth.sql CHECK for ${column} must list exactly: ${list}`,
    );
  };
  expectCheck("role", USER_ROLES);
  expectCheck("status", USER_STATUSES);
  expectCheck("status", API_KEY_STATUSES);
});
