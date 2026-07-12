// POST /api/review-queue/[id]/create-new — promote a queued observation to a
// canonical asset with analyst enrichment (criticality + business_impact,
// plus owner/department where the source lacked them). Routes PRD §4.4.
import { define } from "../../../../utils.ts";
import type { Services } from "../../../../db/container.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { parseBody, requiredFieldsSchema } from "../../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function createNewFromReviewItem(
  deps: { services: Services },
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(requiredFieldsSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    await deps.services.review.createNew(id, parsed.value, ctx);
    return Response.json({ resolved: true, status: "created_new" });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return createNewFromReviewItem(
      ctx.state,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req),
    );
  },
});
