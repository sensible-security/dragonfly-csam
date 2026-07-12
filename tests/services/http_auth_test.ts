// Request-guard tests (auth PRD §3 matrix, §6, §9.4): table-driven RBAC over a
// real AuthService + temp DB, CSRF origin rejection, cookie handling, and the
// strict separation of the session and API-key credential channels.
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
import {
  guardRequest,
  SESSION_COOKIE,
  setSessionCookie,
} from "@/services/http_auth.ts";
import type {
  AuditContext,
  UserRole,
} from "@/db/repositories/interfaces/mod.ts";

const CTX: AuditContext = { actorType: "system", actorId: "test" };
const PASSWORD = "a long valid password";

interface Harness {
  auth: AuthService;
  cookies: Record<UserRole, string>; // Cookie header value per role
  apiKeySecret: string;
}

async function buildHarness(db: DatabaseConnection): Promise<Harness> {
  const auth = new DefaultAuthService({
    users: new TursoUserRepository(db),
    sessions: new TursoSessionRepository(db),
    apiKeys: new TursoApiKeyRepository(db),
    hasher: new Pbkdf2PasswordHasher(1_000),
  });
  const cookies = {} as Record<UserRole, string>;
  for (const role of ["admin", "analyst", "read_only"] as const) {
    await auth.createUser({
      username: role,
      displayName: role,
      role,
      password: PASSWORD,
    }, CTX);
    const login = await auth.login(role, PASSWORD, {});
    cookies[role] = `${SESSION_COOKIE}=${login!.token}`;
  }
  const { secret } = await auth.createApiKey({ name: "scanner-1" }, CTX);
  return { auth, cookies, apiKeySecret: secret };
}

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://dragonfly.local${path}`, { method, headers });
}

async function expectBlocked(
  result: Awaited<ReturnType<typeof guardRequest>>,
  status: number,
  code?: string,
): Promise<Response> {
  assert(result.kind === "response", `expected a ${status} block`);
  assertEquals(result.response.status, status);
  if (code) {
    const body = await result.response.json();
    assertEquals(body.error.code, code);
  }
  return result.response;
}

Deno.test("guardRequest enforces the §3 permission matrix", async () => {
  await withTempDb(async (db) => {
    const h = await buildHarness(db);
    const ok = async (req: Request, kind?: "user" | "connector") => {
      const result = await guardRequest(req, h.auth);
      assert(
        result.kind === "ok",
        `expected pass for ${req.method} ${req.url}`,
      );
      if (kind) assertEquals(result.identity?.kind, kind);
      return result;
    };

    // Open routes: anonymous.
    await ok(request("GET", "/api/health"));
    await ok(request("GET", "/login"));
    await ok(request("POST", "/login"));

    // Anonymous elsewhere: API 401, UI redirect to /login with next=.
    await expectBlocked(
      await guardRequest(request("GET", "/api/devices"), h.auth),
      401,
      "unauthenticated",
    );
    const redirect = await expectBlocked(
      await guardRequest(request("GET", "/devices?status=authorized"), h.auth),
      303,
    );
    assertEquals(
      redirect.headers.get("location"),
      "/login?next=%2Fdevices%3Fstatus%3Dauthorized",
    );

    // Sessions: reads for everyone, mutations gated by role.
    for (const role of ["admin", "analyst", "read_only"] as const) {
      await ok(request("GET", "/devices", { cookie: h.cookies[role] }), "user");
      await ok(request("GET", "/api/devices", { cookie: h.cookies[role] }));
    }
    await ok(request("POST", "/api/devices", { cookie: h.cookies.analyst }));
    await ok(
      request("PATCH", "/api/devices/x/status", { cookie: h.cookies.admin }),
    );
    await expectBlocked(
      await guardRequest(
        request("POST", "/api/devices", { cookie: h.cookies.read_only }),
        h.auth,
      ),
      403,
      "forbidden",
    );

    // Admin surface: admin only.
    await ok(request("GET", "/api/admin/users", { cookie: h.cookies.admin }));
    await expectBlocked(
      await guardRequest(
        request("GET", "/api/admin/users", { cookie: h.cookies.analyst }),
        h.auth,
      ),
      403,
      "forbidden",
    );

    // Logout needs a session.
    await ok(request("POST", "/logout", { cookie: h.cookies.read_only }));
    const anonLogout = await guardRequest(request("POST", "/logout"), h.auth);
    await expectBlocked(anonLogout, 303);
  });
});

Deno.test("credential channels are non-interchangeable (PRD Assumption 11)", async () => {
  await withTempDb(async (db) => {
    const h = await buildHarness(db);

    // API key on the ingest endpoint: the only place it works.
    const viaKey = await guardRequest(
      request("POST", "/api/ingest/scanner_json", {
        "x-api-key": h.apiKeySecret,
      }),
      h.auth,
    );
    assert(viaKey.kind === "ok");
    assertEquals(viaKey.identity, {
      kind: "connector",
      apiKeyId: (await h.auth.listApiKeys({ limit: 1, offset: 0 })).items[0].id,
      sourceName: "scanner-1",
    });

    // Bearer form works too.
    const viaBearer = await guardRequest(
      request("POST", "/api/ingest/scanner_json", {
        authorization: `Bearer ${h.apiKeySecret}`,
      }),
      h.auth,
    );
    assert(viaBearer.kind === "ok");

    // A session cookie does NOT authenticate ingest.
    await expectBlocked(
      await guardRequest(
        request("POST", "/api/ingest/scanner_json", {
          cookie: h.cookies.admin,
        }),
        h.auth,
      ),
      401,
      "api_key_required",
    );

    // An API key does NOT authenticate mutations, even on read-API paths
    // (read access itself is covered by the 5.3 tests below).
    await expectBlocked(
      await guardRequest(
        request("POST", "/api/devices", { "x-api-key": h.apiKeySecret }),
        h.auth,
      ),
      403,
      "api_key_forbidden",
    );

    // Revoked key stops working immediately.
    const key = (await h.auth.listApiKeys({ limit: 1, offset: 0 })).items[0];
    await h.auth.revokeApiKey(key.id, CTX);
    await expectBlocked(
      await guardRequest(
        request("POST", "/api/ingest/scanner_json", {
          "x-api-key": h.apiKeySecret,
        }),
        h.auth,
      ),
      401,
      "invalid_api_key",
    );
  });
});

Deno.test("API keys read the inventory APIs but nothing else (5.3 spec)", async () => {
  await withTempDb(async (db) => {
    const h = await buildHarness(db);
    const key = { "x-api-key": h.apiKeySecret };

    // GET/HEAD on every allowlisted read surface resolves a connector
    // identity, including detail subpaths.
    for (
      const path of [
        "/api/devices",
        "/api/devices/some-id",
        "/api/software",
        "/api/source-records",
        "/api/audit-log",
        "/api/review-queue",
      ]
    ) {
      const result = await guardRequest(request("GET", path, key), h.auth);
      assert(result.kind === "ok", `expected key read to pass for ${path}`);
      assertEquals(result.identity?.kind, "connector");
      assert(
        result.identity?.kind === "connector" &&
          result.identity.sourceName === "scanner-1",
      );
    }
    const head = await guardRequest(
      request("HEAD", "/api/devices", key),
      h.auth,
    );
    assert(head.kind === "ok");

    // Refused without resolution everywhere else: mutations, admin, UI
    // routes, non-allowlisted API reads, and segment-prefix confusion.
    for (
      const [method, path] of [
        ["POST", "/api/devices"],
        ["PATCH", "/api/devices/some-id/status"],
        ["GET", "/api/admin/users"],
        ["POST", "/api/admin/api-keys"],
        ["GET", "/devices"],
        ["GET", "/"],
        ["POST", "/logout"],
        ["GET", "/api/ingestion-batches/x/errors"],
        ["GET", "/api/devicesx"],
      ] as const
    ) {
      await expectBlocked(
        await guardRequest(request(method, path, key), h.auth),
        403,
        "api_key_forbidden",
      );
    }

    // The refusal is channel-level, so it applies even when a valid session
    // cookie rides along (spec Assumption 3: the key channel wins).
    await expectBlocked(
      await guardRequest(
        request("POST", "/api/devices", { ...key, cookie: h.cookies.admin }),
        h.auth,
      ),
      403,
      "api_key_forbidden",
    );

    // Invalid key on an allowed read path: 401, same as ingest.
    await expectBlocked(
      await guardRequest(
        request("GET", "/api/devices", { "x-api-key": "dfk_not_a_real_key" }),
        h.auth,
      ),
      401,
      "invalid_api_key",
    );

    // Revoked key stops reading immediately.
    const created =
      (await h.auth.listApiKeys({ limit: 1, offset: 0 })).items[0];
    await h.auth.revokeApiKey(created.id, CTX);
    await expectBlocked(
      await guardRequest(request("GET", "/api/devices", key), h.auth),
      401,
      "invalid_api_key",
    );
  });
});

Deno.test("invalid or stale session cookies get 401/redirect plus cookie clearing", async () => {
  await withTempDb(async (db) => {
    const h = await buildHarness(db);
    const stale = await guardRequest(
      request("GET", "/api/devices", {
        cookie: `${SESSION_COOKIE}=dead-token`,
      }),
      h.auth,
    );
    const res = await expectBlocked(stale, 401, "unauthenticated");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert(setCookie.includes(`${SESSION_COOKIE}=;`), "stale cookie cleared");
    assert(setCookie.includes("Max-Age=0"));

    const logout = await h.auth.login("admin", PASSWORD, {});
    await h.auth.logout(logout!.token, {});
    await expectBlocked(
      await guardRequest(
        request("GET", "/devices", {
          cookie: `${SESSION_COOKIE}=${logout!.token}`,
        }),
        h.auth,
      ),
      303,
    );
  });
});

Deno.test("mutating session requests reject cross-origin Origin headers (CSRF)", async () => {
  await withTempDb(async (db) => {
    const h = await buildHarness(db);

    // Same-origin mutation passes.
    const same = await guardRequest(
      request("POST", "/api/devices", {
        cookie: h.cookies.analyst,
        origin: "http://dragonfly.local",
      }),
      h.auth,
    );
    assert(same.kind === "ok");

    // Cross-origin mutation is rejected even with a valid session.
    await expectBlocked(
      await guardRequest(
        request("POST", "/api/devices", {
          cookie: h.cookies.analyst,
          origin: "https://evil.example",
        }),
        h.auth,
      ),
      403,
      "csrf_rejected",
    );

    // GETs don't carry the check; API-key requests are cookie-less and exempt.
    const read = await guardRequest(
      request("GET", "/api/devices", {
        cookie: h.cookies.analyst,
        origin: "https://evil.example",
      }),
      h.auth,
    );
    assert(read.kind === "ok");
  });
});

Deno.test("POST /login is CSRF-guarded (login-CSRF defense)", async () => {
  await withTempDb(async (db) => {
    const h = await buildHarness(db);

    // Cross-origin login POST is rejected before any credential is minted.
    await expectBlocked(
      await guardRequest(
        request("POST", "/login", { origin: "https://evil.example" }),
        h.auth,
      ),
      403,
      "csrf_rejected",
    );

    // Same-origin and Origin-less (curl) login posts still pass the guard.
    const same = await guardRequest(
      request("POST", "/login", { origin: "http://dragonfly.local" }),
      h.auth,
    );
    assert(same.kind === "ok");
    const noOrigin = await guardRequest(request("POST", "/login"), h.auth);
    assert(noOrigin.kind === "ok");
  });
});

Deno.test("GET /login resolves an existing session so the page can redirect home", async () => {
  await withTempDb(async (db) => {
    const h = await buildHarness(db);
    const result = await guardRequest(
      request("GET", "/login", { cookie: h.cookies.admin }),
      h.auth,
    );
    assert(result.kind === "ok");
    assertEquals(result.identity?.kind, "user");
  });
});

Deno.test("setSessionCookie emits hardened attributes", () => {
  const secure = setSessionCookie("tok123", 3_600, true);
  assert(secure.startsWith(`${SESSION_COOKIE}=tok123;`));
  assert(secure.includes("HttpOnly"));
  assert(secure.includes("SameSite=Lax"));
  assert(secure.includes("Path=/"));
  assert(secure.includes("Max-Age=3600"));
  assert(secure.includes("Secure"));
  assert(!setSessionCookie("tok123", 3_600, false).includes("Secure"));
});
