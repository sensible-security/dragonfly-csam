// GET /api/review-queue — the human-review queue, filterable/sortable/
// paginated (routes PRD §4.4). List goes through ReviewService (which owns
// queue semantics such as the pending default).
import { define } from "../../../utils.ts";
import type { Services } from "../../../db/container.ts";
import { parseReviewQueueQuery } from "../../(_shared)/query.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function listReviewQueue(
  services: Services,
  search: URLSearchParams,
): Promise<Response> {
  const parsed = parseReviewQueueQuery(search);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const page = await services.review.list(
      parsed.value.filter,
      parsed.value.sort,
      parsed.value.page,
    );
    return Response.json(page);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => listReviewQueue(ctx.state.services, ctx.url.searchParams),
});
