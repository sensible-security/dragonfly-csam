// GET /api/software/[id] — the composed SoftwareDetail DTO (routes PRD §4.2):
// catalog facts + installations with resolved host devices + active documented
// exceptions (Safeguards 2.2/2.3) + provenance + staging records.
import { define } from "../../../utils.ts";
import type { Repositories } from "../../../db/container.ts";
import { buildSoftwareDetail } from "../../(_shared)/detail.ts";
import {
  errorResponse,
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";
import { parseBody, updateSoftwareSchema } from "../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function getSoftware(
  repositories: Repositories,
  id: string,
): Promise<Response> {
  try {
    const detail = await buildSoftwareDetail(repositories, id);
    if (!detail) {
      return errorResponse(404, "not_found", `software not found: ${id}`);
    }
    return Response.json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
}

// PATCH edits mutable fields only — authorization/support statuses have their
// own audited routes (routes PRD Gate Q1).
export async function patchSoftware(
  repositories: Repositories,
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(updateSoftwareSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const software = await repositories.software.update(id, parsed.value, ctx);
    return Response.json(software);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => getSoftware(ctx.state.repositories, ctx.params.id),
  PATCH: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return patchSoftware(
      ctx.state.repositories,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req),
    );
  },
});
