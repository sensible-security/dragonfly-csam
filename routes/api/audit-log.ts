// GET /api/audit-log — read-only audit query (routes PRD §4.5; CIS Control 8
// front-load). Append-only by contract: this route exposes no writes, by
// omission. Before/after diffs travel as JSON strings for the viewer.
import { define } from "../../utils.ts";
import type { Repositories } from "../../db/container.ts";
import { parseAuditListQuery } from "../(_shared)/query.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../(_shared)/errors.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function listAuditLog(
  repositories: Repositories,
  search: URLSearchParams,
): Promise<Response> {
  const parsed = parseAuditListQuery(search);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const page = await repositories.auditLog.query(
      parsed.value.filter,
      parsed.value.page,
    );
    return Response.json(page);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => listAuditLog(ctx.state.repositories, ctx.url.searchParams),
});
