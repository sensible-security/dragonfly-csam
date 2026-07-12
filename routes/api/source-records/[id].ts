// GET /api/source-records/[id] — staging-record detail (routes PRD §4.3):
// verbatim raw payload (untrusted DATA — consumers render it inert),
// normalized payload, reconciliation outcome, and the source name.
import { define } from "../../../utils.ts";
import type { Repositories } from "../../../db/container.ts";
import { errorResponse, toErrorResponse } from "../../(_shared)/errors.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function getSourceRecord(
  repositories: Repositories,
  id: string,
): Promise<Response> {
  try {
    const record = await repositories.sourceRecords.getById(id);
    if (!record) {
      return errorResponse(404, "not_found", `source record not found: ${id}`);
    }
    const source = await repositories.sourceRecords.getSourceById(
      record.sourceId,
    );
    return Response.json({ record, sourceName: source?.name ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => getSourceRecord(ctx.state.repositories, ctx.params.id),
});
