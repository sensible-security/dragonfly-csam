// POST /logout (auth PRD §6): revokes the session server-side (audited as
// session delete), clears the cookie, and lands on /login. POST-only — a
// state change must not be reachable by link (and it is CSRF-guarded).
import { define } from "../utils.ts";
import type { AuthService } from "../services/auth_service.ts";
import {
  clearSessionCookie,
  cookieSecure,
  sessionTokenFrom,
} from "../services/http_auth.ts";

export interface HandleLogoutArgs {
  request: Request;
  auth: AuthService;
  sourceAddress?: string;
}

// Exported for direct unit testing without booting the Fresh app.
export async function handleLogout(args: HandleLogoutArgs): Promise<Response> {
  const token = sessionTokenFrom(args.request.headers);
  if (token) {
    await args.auth.logout(token, { sourceAddress: args.sourceAddress });
  }
  const url = new URL(args.request.url);
  return new Response(null, {
    status: 303,
    headers: {
      location: "/login",
      "set-cookie": clearSessionCookie(cookieSecure(url)),
    },
  });
}

export const handler = define.handlers({
  POST: (ctx) =>
    handleLogout({
      request: ctx.req,
      auth: ctx.state.services.auth,
      sourceAddress: ctx.req.headers.get("x-forwarded-for") ?? undefined,
    }),
});
