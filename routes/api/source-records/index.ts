// GET /api/source-records — read-only staging listing per source (routes PRD
// §4.3). Requires ?sourceId= or ?sourceName= (staging is only meaningful per
// source); rows carry their reconciliation outcome.
import { z } from "zod";
import { define } from "../../../utils.ts";
import type { Repositories } from "../../../db/container.ts";
import { zodIssues } from "../../(_shared)/query.ts";
import {
  errorResponse,
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";

const listSchema = z.object({
  sourceId: z.string().min(1).optional(),
  sourceName: z.string().min(1).optional(),
  limit: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : Number(v)),
    z.number().int().optional(),
  ),
  offset: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : Number(v)),
    z.number().int().optional(),
  ),
}).strict();

// Exported for direct unit testing without booting the Fresh app.
export async function listSourceRecords(
  repositories: Repositories,
  search: URLSearchParams,
): Promise<Response> {
  const raw: Record<string, string> = {};
  for (const [key, value] of search.entries()) raw[key] = value;
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) {
    return validationErrorResponse(zodIssues(parsed.error));
  }
  const q = parsed.data;

  try {
    let sourceId = q.sourceId;
    if (!sourceId && q.sourceName) {
      const source = await repositories.sourceRecords.getSourceByName(
        q.sourceName,
      );
      if (!source) {
        return errorResponse(404, "not_found", "source not found");
      }
      sourceId = source.id;
    }
    if (!sourceId) {
      return errorResponse(
        400,
        "validation_error",
        "sourceId or sourceName is required",
      );
    }

    const page = await repositories.sourceRecords.listBySource(sourceId, {
      limit: Math.min(Math.max(q.limit ?? 50, 1), 200),
      offset: Math.max(q.offset ?? 0, 0),
    });
    return Response.json(page);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => listSourceRecords(ctx.state.repositories, ctx.url.searchParams),
});
