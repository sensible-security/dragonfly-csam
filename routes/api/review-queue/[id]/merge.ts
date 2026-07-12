// POST /api/review-queue/[id]/merge — confirm a human-chosen candidate
// (routes PRD §4.4). ReviewService links the staged record, audits the merge,
// and closes the item; a non-pending item answers 409 not_pending.
import { define } from "../../../../utils.ts";
import type { Services } from "../../../../db/container.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { mergeReviewSchema, parseBody } from "../../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function mergeReviewItem(
  deps: { services: Services },
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(mergeReviewSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    await deps.services.review.merge(id, parsed.value.targetEntityId, ctx);
    return Response.json({ resolved: true, status: "merged" });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return mergeReviewItem(
      ctx.state,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req, ctx.state.identity),
    );
  },
});
