// POST /api/admin/api-keys/:id/revoke (auth PRD §6): immediate, audited
// (status_change) revocation. Keys are never deleted — the audit trail keeps
// pointing at a real row.
import { define } from "../../../../../utils.ts";
import type { AuthService } from "../../../../../services/auth_service.ts";
import type { AuditContext } from "../../../../../db/repositories/interfaces/mod.ts";
import { toErrorResponse } from "../../../../(_shared)/errors.ts";
import { auditContextFrom } from "../../../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function revokeApiKey(
  auth: AuthService,
  id: string,
  ctx: AuditContext = auditContextFrom(),
): Promise<Response> {
  try {
    return Response.json(await auth.revokeApiKey(id, ctx));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: (ctx) =>
    revokeApiKey(
      ctx.state.services.auth,
      ctx.params.id,
      auditContextFrom(ctx.req, ctx.state.identity),
    ),
});
