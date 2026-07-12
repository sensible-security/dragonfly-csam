// /api/admin/users (auth PRD §6, Assumption 8): list + create users. The
// middleware already restricts /api/admin/* to the admin role; handlers call
// the AuthService only (hashing never happens in routes).
import { z } from "zod";
import { define } from "../../../../utils.ts";
import type { AuthService } from "../../../../services/auth_service.ts";
import { USER_ROLES } from "../../../../db/repositories/interfaces/mod.ts";
import type { AuditContext } from "../../../../db/repositories/interfaces/mod.ts";
import { parseBody } from "../../../(_shared)/body.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";
import { parsePageQuery } from "../../../(_shared)/query.ts";

export const createUserSchema = z.object({
  username: z.string().regex(
    /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$/i,
    "3-64 chars: letters, digits, dot, underscore, hyphen",
  ),
  displayName: z.string().min(1).max(128),
  role: z.enum(USER_ROLES),
  password: z.string().min(12).max(1024),
}).strict();

// Exported for direct unit testing without booting the Fresh app.
export async function listUsers(
  auth: AuthService,
  search: URLSearchParams,
): Promise<Response> {
  const parsed = parsePageQuery(search);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);
  return Response.json(await auth.listUsers(parsed.value));
}

// Exported for direct unit testing without booting the Fresh app.
export async function createUser(
  auth: AuthService,
  body: unknown,
  ctx: AuditContext = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(createUserSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);
  try {
    const user = await auth.createUser(parsed.value, ctx);
    return Response.json(user, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => listUsers(ctx.state.services.auth, ctx.url.searchParams),
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return createUser(
      ctx.state.services.auth,
      body.value,
      auditContextFrom(ctx.req, ctx.state.identity),
    );
  },
});
