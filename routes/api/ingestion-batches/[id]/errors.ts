// GET /api/ingestion-batches/[id]/errors — the downloadable per-row error
// report (routes PRD §4.6; ingestion PRD §9.2) as text/csv. Cells are quoted
// and formula-guarded: quarantined row content is untrusted DATA and must not
// execute when the analyst opens the report in a spreadsheet (AGENTS.md §2.7).
import { define } from "../../../../utils.ts";
import type { Repositories } from "../../../../db/container.ts";
import { errorResponse, toErrorResponse } from "../../../(_shared)/errors.ts";

// Quote per RFC 4180 and neutralize spreadsheet formula triggers.
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

// Exported for direct unit testing without booting the Fresh app.
export async function downloadBatchErrors(
  repositories: Repositories,
  batchId: string,
): Promise<Response> {
  try {
    const batch = await repositories.ingestionBatches.getById(batchId);
    if (!batch) {
      return errorResponse(404, "not_found", `batch not found: ${batchId}`);
    }

    const errors = await repositories.ingestionBatches.listErrors(batchId);
    const lines = ["row,external_id,field,code,message,raw_row"];
    for (const error of errors) {
      for (const issue of error.issues) {
        lines.push([
          csvCell(error.rowRef),
          csvCell(error.externalId ?? ""),
          csvCell(issue.field),
          csvCell(issue.code),
          csvCell(issue.message),
          csvCell(error.rawRow),
        ].join(","));
      }
    }

    return new Response(lines.join("\n") + "\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition":
          `attachment; filename="batch-${batchId}-errors.csv"`,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => downloadBatchErrors(ctx.state.repositories, ctx.params.id),
});
