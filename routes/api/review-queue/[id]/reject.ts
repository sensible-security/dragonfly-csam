// POST /api/review-queue/[id]/reject — close a queue item without touching
// inventory; the staged record is marked rejected (routes PRD §4.4).
import { define } from "../../../../utils.ts";
import type { Services } from "../../../../db/container.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { parseBody, rejectReviewSchema } from "../../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function rejectReviewItem(
  deps: { services: Services },
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(rejectReviewSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    await deps.services.review.reject(id, parsed.value.reason, ctx);
    return Response.json({ resolved: true, status: "rejected" });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return rejectReviewItem(
      ctx.state,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req, ctx.state.identity),
    );
  },
});
