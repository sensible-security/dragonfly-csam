// /login — the door (auth PRD §6). Server-rendered Beer CSS form, no island.
// POST is form-encoded; failure re-lands here with a generic flag (which of
// username/password failed is never disclosed); success sets the session
// cookie and follows a validated `next` (open-redirect guard).
import { page } from "fresh";
import { z } from "zod";
import { define } from "../utils.ts";
import type { AuthService } from "../services/auth_service.ts";
import { cookieSecure, setSessionCookie } from "../services/http_auth.ts";

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
});

// Open-redirect guard: same-site paths only.
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

export interface HandleLoginArgs {
  request: Request;
  auth: AuthService;
  sourceAddress?: string;
}

// Exported for direct unit testing without booting the Fresh app.
export async function handleLogin(args: HandleLoginArgs): Promise<Response> {
  const form = await args.request.formData();
  const parsed = loginSchema.safeParse({
    username: form.get("username") ?? "",
    password: form.get("password") ?? "",
    next: form.get("next")?.toString() || undefined,
  });
  const url = new URL(args.request.url);
  const retry = (next?: string) => {
    const params = new URLSearchParams({ error: "1" });
    if (next) params.set("next", next);
    return new Response(null, {
      status: 303,
      headers: { location: `/login?${params}` },
    });
  };
  if (!parsed.success) return retry();

  const { username, password, next } = parsed.data;
  const result = await args.auth.login(username, password, {
    sourceAddress: args.sourceAddress,
  });
  if (!result) return retry(next);

  const maxAge = Math.max(
    1,
    Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000),
  );
  return new Response(null, {
    status: 303,
    headers: {
      location: safeNext(next),
      "set-cookie": setSessionCookie(result.token, maxAge, cookieSecure(url)),
    },
  });
}

export const handler = define.handlers({
  GET: (ctx) => {
    // Already signed in (middleware resolved a session): go home.
    if (ctx.state.identity) {
      return new Response(null, { status: 303, headers: { location: "/" } });
    }
    return page({
      failed: ctx.url.searchParams.get("error") === "1",
      next: ctx.url.searchParams.get("next") ?? undefined,
    });
  },
  POST: (ctx) =>
    handleLogin({
      request: ctx.req,
      auth: ctx.state.services.auth,
      sourceAddress: ctx.req.headers.get("x-forwarded-for") ?? undefined,
    }),
});

export default define.page<typeof handler>(function LoginPage(props) {
  const { failed, next } = props.data;
  return (
    <article class="border round medium-width center middle-align">
      <div class="padding">
        <nav>
          <i class="extra">hub</i>
          <h5>Dragonfly CSAM</h5>
        </nav>
        <p>Sign in to continue.</p>
        {failed && (
          <p class="error-text" role="alert">
            Sign-in failed. Check your username and password.
          </p>
        )}
        <form method="post" action="/login">
          {next && <input type="hidden" name="next" value={next} />}
          <div class="field label border">
            <input
              type="text"
              name="username"
              placeholder=" "
              autocomplete="username"
              required
            />
            <label>Username</label>
          </div>
          <div class="field label border">
            <input
              type="password"
              name="password"
              placeholder=" "
              autocomplete="current-password"
              required
            />
            <label>Password</label>
          </div>
          <button type="submit" class="responsive">Sign in</button>
        </form>
      </div>
    </article>
  );
});
