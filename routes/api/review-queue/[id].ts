// GET /api/review-queue/[id] — review-item detail: candidates, projected
// attributes, and status (routes PRD §4.4).
import { define } from "../../../utils.ts";
import type { Repositories } from "../../../db/container.ts";
import { errorResponse, toErrorResponse } from "../../(_shared)/errors.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function getReviewItem(
  repositories: Repositories,
  id: string,
): Promise<Response> {
  try {
    const item = await repositories.reviewQueue.getById(id);
    if (!item) {
      return errorResponse(404, "not_found", `review item not found: ${id}`);
    }
    return Response.json(item);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => getReviewItem(ctx.state.repositories, ctx.params.id),
});
