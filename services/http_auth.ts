// Request guard (auth PRD §3 matrix, §6): one pure decision function the
// main.ts middleware calls on every request, unit-testable without Fresh.
// Order: open routes → credential resolution (cookie everywhere; API key only
// under /api/ingest/) → RBAC → CSRF origin check. Replaces the Phase 3
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

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

export async function guardRequest(
  req: Request,
  auth: AuthService,
): Promise<GuardResult> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Open routes (PRD Assumption 12): the health probe and the door itself.
  // Static assets are served by staticFiles() before this guard runs.
  if (path === "/api/health" || path === "/login") return { kind: "ok" };

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

    // CSRF (PRD Assumption 10): SameSite=Lax plus an Origin check on
    // mutations. Absent Origin (curl, same-site form posts) is allowed.
    if (mutating) {
      // A literal "Origin: null" (sandboxed iframe, data: URL) parses to no
      // host below and is rejected like any other foreign origin.
      const origin = req.headers.get("origin");
      if (origin) {
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost !== url.host) {
          return {
            kind: "response",
            response: jsonError(
              403,
              "csrf_rejected",
              "cross-origin request rejected",
            ),
          };
        }
      }
    }
  }

  return { kind: "ok", identity };
}
