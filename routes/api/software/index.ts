// /api/software (routes PRD §4.2): GET list + filter + pagination (rows carry
// supportStatus/eolDate for the Safeguard 2.2 flag); POST creates ONE catalog
// entry through the manual connector + reconciliation (Gate Q1).
import { define } from "../../../utils.ts";
import type { Repositories } from "../../../db/container.ts";
import { parseSoftwareListQuery } from "../../(_shared)/query.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";
import { createAsset, type CreateDeps } from "../../(_shared)/create.ts";
import { auditContextFrom, readJsonBody } from "../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function listSoftware(
  repositories: Repositories,
  search: URLSearchParams,
): Promise<Response> {
  const parsed = parseSoftwareListQuery(search);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const page = await repositories.software.list(
      parsed.value.filter,
      parsed.value.page,
    );
    return Response.json(page);
  } catch (err) {
    return toErrorResponse(err);
  }
}

// Exported for direct unit testing without booting the Fresh app.
export function createSoftware(
  deps: CreateDeps,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  return createAsset(deps, "software", body, ctx);
}

export const handler = define.handlers({
  GET: (ctx) => listSoftware(ctx.state.repositories, ctx.url.searchParams),
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return createSoftware(ctx.state, body.value, auditContextFrom(ctx.req));
  },
});
