// POST /api/import/csv — the analyst CSV upload (routes PRD §4.6). Distinct
// from the API-key /api/ingest/ machine endpoints (ingestion PRD Assumption
// 9): this is a session-guarded UI action in Phase 5; Phase 4 runs it open
// like every other analyst route. Body carries the file text + the header →
// canonical-target column mapping; the pipeline stages, quarantines, and
// reconciles, returning the full batch result the uploader renders.
import { define } from "../../../utils.ts";
import type { Services } from "../../../db/container.ts";
import type { AuditContext } from "../../../db/repositories/interfaces/mod.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";
import { csvImportSchema, parseBody } from "../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function importCsv(
  deps: { services: Services },
  body: unknown,
  ctx: AuditContext = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(csvImportSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const result = await deps.services.ingestion.ingest({
      sourceType: "csv_import",
      sourceName: parsed.value.sourceName,
      payload: parsed.value.csvText,
      options: { columnMapping: parsed.value.columnMapping },
    }, ctx);
    return Response.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return importCsv(ctx.state, body.value, auditContextFrom(ctx.req));
  },
});
