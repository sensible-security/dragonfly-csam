// POST /api/software/[id]/authorization — Safeguard 2.3 transition endpoint
// (routes PRD §4.2). exception_documented requires an active documented
// exception; the repository enforces that and it surfaces as a 422.
import { define } from "../../../../utils.ts";
import type { Repositories } from "../../../../db/container.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import {
  parseBody,
  softwareAuthorizationSchema,
} from "../../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function setSoftwareAuthorization(
  repositories: Repositories,
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(softwareAuthorizationSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const software = await repositories.software.setAuthorizationStatus(
      id,
      parsed.value.status,
      ctx,
    );
    return Response.json(software);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return setSoftwareAuthorization(
      ctx.state.repositories,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req, ctx.state.identity),
    );
  },
});
