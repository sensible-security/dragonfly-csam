// POST /api/software/[id]/support — Safeguard 2.2 support-status transition
// (routes PRD §4.2), through the audited repository setter.
import { define } from "../../../../utils.ts";
import type { Repositories } from "../../../../db/container.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { parseBody, softwareSupportSchema } from "../../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function setSoftwareSupport(
  repositories: Repositories,
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(softwareSupportSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const software = await repositories.software.setSupportStatus(
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
    return setSoftwareSupport(
      ctx.state.repositories,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req),
    );
  },
});
