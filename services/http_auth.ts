// Request guard (auth PRD §3 matrix, §6; read-access PRD §2): one pure
// decision function the main.ts middleware calls on every request,
// unit-testable without Fresh. Order: open routes → credential resolution
// (API key under /api/ingest/ and for GET/HEAD on the read-API allowlist;
// cookie everywhere else) → RBAC → CSRF origin check. Replaces the Phase 3
// ingest_auth stub.
import type { AuthIdentity } from "../db/repositories/interfaces/mod.ts";
import type { AuthService } from "./auth_service.ts";

export const SESSION_COOKIE = "dragonfly_session";

export type GuardResult =
  | { kind: "ok"; identity?: AuthIdentity }
  | { kind: "response"; response: Response };

function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export function setSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; ` +
    `Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return setSessionCookie("", 0, secure);
}

// Whether Set-Cookie should carry Secure: https in production, opt-in via env
// for TLS-terminating proxies in front of a plain-http container.
export function cookieSecure(url: URL): boolean {
  return url.protocol === "https:" ||
    Deno.env.get("DRAGONFLY_COOKIE_SECURE") === "1";
}

export function sessionTokenFrom(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

export function apiKeyFrom(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return null;
}

const MUTATING_EXEMPT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The JSON read surfaces an API key may GET/HEAD (read-access PRD §2 —
// SIEM/GRC tooling, AGENTS.md §4.3). Everything else on the key channel is
// ingest-only.
const API_KEY_READ_PREFIXES = [
  "/api/devices",
  "/api/software",
  "/api/source-records",
  "/api/audit-log",
  "/api/review-queue",
];

function apiKeyReadablePath(path: string): boolean {
  return API_KEY_READ_PREFIXES.some((prefix) =>
    path === prefix || path.startsWith(prefix + "/")
  );
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

// CSRF (PRD Assumption 10): SameSite=Lax plus an Origin check on mutations. A
// present Origin whose host differs from ours is a cross-site request; absent
// Origin (curl, some same-site form posts) is allowed. A literal "Origin:
// null" (sandboxed iframe, data: URL) fails to parse to our host and is
// rejected like any other foreign origin.
function crossOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  return originHost !== url.host;
}

function csrfRejected(): Response {
  return jsonError(403, "csrf_rejected", "cross-origin request rejected");
}

export async function guardRequest(
  req: Request,
  auth: AuthService,
): Promise<GuardResult> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Open route (PRD Assumption 12): the health probe carries no identity and
  // no CSRF surface. Static assets are served by staticFiles() before this
  // guard runs.
  if (path === "/api/health") return { kind: "ok" };

  // The login page is open, but POST /login mints a session cookie, so it
  // gets the same cross-origin CSRF guard as any other mutation — otherwise an
  // attacker could log a victim's browser into an account of the attacker's
  // choosing (login CSRF). We also resolve any existing session so the page
  // can bounce an already-signed-in user home (login.tsx).
  if (path === "/login") {
    if (!MUTATING_EXEMPT_METHODS.has(req.method) && crossOrigin(req, url)) {
      return { kind: "response", response: csrfRejected() };
    }
    const openToken = sessionTokenFrom(req.headers);
    const openIdentity = openToken
      ? await auth.resolveSession(openToken)
      : null;
    return { kind: "ok", identity: openIdentity ?? undefined };
  }

  // Ingest: API-key channel only — a session cookie is not a credential here
  // and a key is not a credential anywhere else (PRD Assumption 11).
  if (path.startsWith("/api/ingest/")) {
    const key = apiKeyFrom(req.headers);
    if (!key) {
      return {
        kind: "response",
        response: jsonError(
          401,
          "api_key_required",
          "ingest endpoints authenticate with an API key",
        ),
      };
    }
    const identity = await auth.resolveApiKey(key);
    if (!identity) {
      return {
        kind: "response",
        response: jsonError(
          401,
          "invalid_api_key",
          "missing or invalid API key",
        ),
      };
    }
    return { kind: "ok", identity };
  }

  // API-key channel outside ingest (read-access PRD §2): a connector key
  // authenticates GET/HEAD on the read-API allowlist. A key presented
  // anywhere else is refused outright — before resolution, so the response
  // never confirms whether the key is valid — instead of silently falling
  // through to the session channel. The key channel wins even when a session
  // cookie rides along (read-access PRD Assumption 3).
  const presentedKey = apiKeyFrom(req.headers);
  if (presentedKey !== null) {
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (!isRead || !apiKeyReadablePath(path)) {
      return {
        kind: "response",
        response: jsonError(
          403,
          "api_key_forbidden",
          "API keys are limited to ingest and read-only inventory API access",
        ),
      };
    }
    const identity = await auth.resolveApiKey(presentedKey);
    if (!identity) {
      return {
        kind: "response",
        response: jsonError(
          401,
          "invalid_api_key",
          "missing or invalid API key",
        ),
      };
    }
    return { kind: "ok", identity };
  }

  // Everything else: session channel.
  const token = sessionTokenFrom(req.headers);
  const identity = token ? await auth.resolveSession(token) : null;
  if (!identity) {
    // A presented-but-dead token is cleared so browsers stop sending it.
    const headers = new Headers();
    if (token) {
      headers.set("set-cookie", clearSessionCookie(cookieSecure(url)));
    }
    if (isApiPath(path)) {
      return {
        kind: "response",
        response: jsonError(
          401,
          "unauthenticated",
          "authentication required",
          headers,
        ),
      };
    }
    // UI: send the browser to the login page, preserving the destination for
    // reads (open-redirect guard on the way back lives in the login route).
    if (MUTATING_EXEMPT_METHODS.has(req.method)) {
      headers.set(
        "location",
        `/login?next=${encodeURIComponent(path + url.search)}`,
      );
    } else {
      headers.set("location", "/login");
    }
    return {
      kind: "response",
      response: new Response(null, { status: 303, headers }),
    };
  }

  // RBAC (§3). Only user identities reach here.
  if (identity.kind === "user") {
    const forbidden = () =>
      ({
        kind: "response",
        response: jsonError(403, "forbidden", "insufficient role"),
      }) as const;

    if (path === "/api/admin" || path.startsWith("/api/admin/")) {
      if (identity.role !== "admin") return forbidden();
    }

    // Logging out is a mutation of one's own session, not of inventory —
    // every role may do it.
    const mutating = !MUTATING_EXEMPT_METHODS.has(req.method);
    if (mutating && identity.role === "read_only" && path !== "/logout") {
      return forbidden();
    }

    if (mutating && crossOrigin(req, url)) {
      return { kind: "response", response: csrfRejected() };
    }
  }

  return { kind: "ok", identity };
}
