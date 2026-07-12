// POST /api/review-queue/bulk-create-new — promote many selected items with
// one enrichment (ingestion PRD gate decision 1). Always 200 with a
// BulkResult: per-item succeeded/failed outcomes, never an all-or-nothing
// abort (routes PRD §4.4).
import { define } from "../../../utils.ts";
import type { Services } from "../../../db/container.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";
import { bulkCreateNewSchema, parseBody } from "../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function bulkCreateNew(
  deps: { services: Services },
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(bulkCreateNewSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const result = await deps.services.review.bulkCreateNew(
      parsed.value.itemIds,
      parsed.value.enrichment,
      ctx,
    );
    return Response.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return bulkCreateNew(ctx.state, body.value, auditContextFrom(ctx.req));
  },
});
