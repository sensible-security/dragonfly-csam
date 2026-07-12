// /api/admin/users/:id (auth PRD §6): detail + patch (role, status,
// display name, password reset). Users are disabled, never deleted (PRD
// Assumption 8), and an admin cannot disable their own account.
import { z } from "zod";
import { define } from "../../../../utils.ts";
import type { AuthService } from "../../../../services/auth_service.ts";
import {
  USER_ROLES,
  USER_STATUSES,
} from "../../../../db/repositories/interfaces/mod.ts";
import type { AuditContext } from "../../../../db/repositories/interfaces/mod.ts";
import { parseBody } from "../../../(_shared)/body.ts";
import {
  errorResponse,
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";

export const updateUserSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  password: z.string().min(12).max(1024).optional(),
}).strict().refine(
  (patch) => Object.values(patch).some((v) => v !== undefined),
  { message: "at least one field required" },
);

// Exported for direct unit testing without booting the Fresh app.
export async function getUser(
  auth: AuthService,
  id: string,
): Promise<Response> {
  const user = await auth.getUser(id);
  if (!user) return errorResponse(404, "not_found", `user ${id} not found`);
  return Response.json(user);
}

// Exported for direct unit testing without booting the Fresh app.
export async function updateUser(
  auth: AuthService,
  id: string,
  body: unknown,
  ctx: AuditContext = auditContextFrom(),
  actingUserId?: string,
): Promise<Response> {
  const parsed = parseBody(updateUserSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);
  if (parsed.value.status === "disabled" && id === actingUserId) {
    return errorResponse(
      422,
      "cannot_disable_self",
      "an admin cannot disable their own account",
    );
  }
  try {
    return Response.json(await auth.updateUser(id, parsed.value, ctx));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => getUser(ctx.state.services.auth, ctx.params.id),
  PATCH: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    const identity = ctx.state.identity;
    return updateUser(
      ctx.state.services.auth,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req, identity),
      identity?.kind === "user" ? identity.userId : undefined,
    );
  },
});
