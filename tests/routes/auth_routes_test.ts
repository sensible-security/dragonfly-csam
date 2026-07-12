// Auth route tests (auth PRD §9.5): login/logout handlers (Set-Cookie, 303,
// next-guard, generic failure) and the admin user/API-key endpoints
// (validation, one-time secret, hash-free listings). Handlers are called
// directly over a temp-DB AuthService — no Fresh boot.
import { assert, assertEquals } from "@std/assert";
import { withTempDb } from "../repositories/helpers.ts";
import type { DatabaseConnection } from "@/db/repositories/turso/connection.ts";
import { TursoUserRepository } from "@/db/repositories/turso/user_repository.ts";
import { TursoSessionRepository } from "@/db/repositories/turso/session_repository.ts";
import { TursoApiKeyRepository } from "@/db/repositories/turso/api_key_repository.ts";
import { Pbkdf2PasswordHasher } from "@/services/password.ts";
import {
  type AuthService,
  DefaultAuthService,
} from "@/services/auth_service.ts";
import { SESSION_COOKIE } from "@/services/http_auth.ts";
import { handleLogin, safeNext } from "@/routes/login.tsx";
import { handleLogout } from "@/routes/logout.ts";
import { createUser, listUsers } from "@/routes/api/admin/users/index.ts";
import { updateUser } from "@/routes/api/admin/users/[id].ts";
import {
  createApiKey,
  listApiKeys,
} from "@/routes/api/admin/api-keys/index.ts";
import { revokeApiKey } from "@/routes/api/admin/api-keys/[id]/revoke.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";

const CTX: AuditContext = { actorType: "user", actorId: "admin" };
const PASSWORD = "a long valid password";

function buildAuth(db: DatabaseConnection): AuthService {
  return new DefaultAuthService({
    users: new TursoUserRepository(db),
    sessions: new TursoSessionRepository(db),
    apiKeys: new TursoApiKeyRepository(db),
    hasher: new Pbkdf2PasswordHasher(1_000),
  });
}

function loginRequest(fields: Record<string, string>): Request {
  const form = new URLSearchParams(fields);
  return new Request("http://localhost/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

Deno.test("POST /login sets the session cookie and follows a safe next", async () => {
  await withTempDb(async (db) => {
    const auth = buildAuth(db);
    await auth.createUser({
      username: "ariel",
      displayName: "Ariel",
      role: "analyst",
      password: PASSWORD,
    }, CTX);

    const res = await handleLogin({
      request: loginRequest({
        username: "ariel",
        password: PASSWORD,
        next: "/devices?status=authorized",
      }),
      auth,
    });
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/devices?status=authorized");
    const cookie = res.headers.get("set-cookie") ?? "";
    assert(cookie.startsWith(`${SESSION_COOKIE}=`));
    assert(cookie.includes("HttpOnly"));

    // The issued token resolves to the user.
    const token = cookie.split(";")[0].split("=")[1];
    const identity = await auth.resolveSession(token);
    assertEquals(identity?.kind, "user");
  });
});

Deno.test("failed login lands back on /login with a generic flag, no cookie", async () => {
  await withTempDb(async (db) => {
    const auth = buildAuth(db);
    await auth.createUser({
      username: "ariel",
      displayName: "Ariel",
      role: "analyst",
      password: PASSWORD,
    }, CTX);

    for (
      const fields of [
        { username: "ariel", password: "wrong password here" },
        { username: "nobody", password: PASSWORD },
        { username: "", password: "" },
      ]
    ) {
      const res = await handleLogin({ request: loginRequest(fields), auth });
      assertEquals(res.status, 303);
      assert(res.headers.get("location")!.startsWith("/login?error=1"));
      assertEquals(res.headers.get("set-cookie"), null);
    }
  });
});

Deno.test("safeNext neutralizes open redirects", () => {
  assertEquals(safeNext("/devices"), "/devices");
  assertEquals(safeNext(undefined), "/");
  assertEquals(safeNext("https://evil.example/"), "/");
  assertEquals(safeNext("//evil.example"), "/");
});

Deno.test("POST /logout revokes the session and clears the cookie", async () => {
  await withTempDb(async (db) => {
    const auth = buildAuth(db);
    await auth.createUser({
      username: "out",
      displayName: "Out",
      role: "read_only",
      password: PASSWORD,
    }, CTX);
    const login = await auth.login("out", PASSWORD, {});

    const res = await handleLogout({
      request: new Request("http://localhost/logout", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${login!.token}` },
      }),
      auth,
    });
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/login");
    assert(res.headers.get("set-cookie")!.includes("Max-Age=0"));
    assertEquals(await auth.resolveSession(login!.token), null);
  });
});

Deno.test("admin user endpoints: create, validate, list, patch, self-disable guard", async () => {
  await withTempDb(async (db) => {
    const auth = buildAuth(db);

    const created = await createUser(auth, {
      username: "New.Analyst",
      displayName: "New Analyst",
      role: "analyst",
      password: "long enough password",
    }, CTX);
    assertEquals(created.status, 201);
    const user = await created.json();
    assertEquals(user.username, "new.analyst"); // normalized
    assert(!("passwordHash" in user));

    // Short password and bad role are structured 400s.
    for (
      const bad of [
        { username: "x", displayName: "X", role: "analyst", password: "short" },
        {
          username: "conn",
          displayName: "C",
          role: "connector", // not a user role (PRD Assumption 4)
          password: "long enough password",
        },
      ]
    ) {
      const res = await createUser(auth, bad, CTX);
      assertEquals(res.status, 400);
      assertEquals((await res.json()).error.code, "validation_error");
    }

    // Duplicate username → 409.
    assertEquals(
      (await createUser(auth, {
        username: "new.analyst",
        displayName: "Dup",
        role: "analyst",
        password: "long enough password",
      }, CTX)).status,
      409,
    );

    const listed = await listUsers(auth, new URLSearchParams());
    assertEquals((await listed.json()).total, 1);

    // Patch role; empty patch rejected; self-disable rejected.
    const patched = await updateUser(auth, user.id, { role: "admin" }, CTX);
    assertEquals((await patched.json()).role, "admin");
    assertEquals((await updateUser(auth, user.id, {}, CTX)).status, 400);
    const selfDisable = await updateUser(
      auth,
      user.id,
      { status: "disabled" },
      CTX,
      user.id, // acting user is the target
    );
    assertEquals(selfDisable.status, 422);
    assertEquals((await selfDisable.json()).error.code, "cannot_disable_self");
  });
});

Deno.test("admin api-key endpoints: one-time secret, hash-free listing, revoke", async () => {
  await withTempDb(async (db) => {
    const auth = buildAuth(db);

    const created = await createApiKey(auth, { name: "nessus-dc1" }, CTX);
    assertEquals(created.status, 201);
    const body = await created.json();
    assert(body.key.startsWith("dfk_"));
    assertEquals(body.apiKey.name, "nessus-dc1");

    assertEquals(
      (await createApiKey(auth, { name: "bad name!" }, CTX)).status,
      400,
    );
    assertEquals(
      (await createApiKey(auth, { name: "nessus-dc1" }, CTX)).status,
      409,
    );

    const listed = await listApiKeys(auth, new URLSearchParams());
    const listing = await listed.json();
    assertEquals(listing.total, 1);
    assert(
      !JSON.stringify(listing).includes(body.key),
      "the secret never appears in listings",
    );

    const revoked = await revokeApiKey(auth, body.apiKey.id, CTX);
    assertEquals((await revoked.json()).status, "revoked");
    assertEquals(await auth.resolveApiKey(body.key), null);
    assertEquals(
      (await revokeApiKey(auth, crypto.randomUUID(), CTX)).status,
      404,
    );
  });
});
