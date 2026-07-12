// /api/devices (routes PRD §4.1): GET list + taxonomy filter + pagination
// (repository interface direct, Gate Q2); POST creates ONE device through the
// manual connector + reconciliation (Gate Q1) and reports the outcome.
import { define } from "../../../utils.ts";
import type { Repositories } from "../../../db/container.ts";
import { parseDeviceListQuery } from "../../(_shared)/query.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";
import { createAsset, type CreateDeps } from "../../(_shared)/create.ts";
import { auditContextFrom, readJsonBody } from "../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function listDevices(
  repositories: Repositories,
  search: URLSearchParams,
): Promise<Response> {
  const parsed = parseDeviceListQuery(search);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const page = await repositories.devices.list(
      parsed.value.filter,
      parsed.value.page,
    );
    return Response.json(page);
  } catch (err) {
    return toErrorResponse(err);
  }
}

// Exported for direct unit testing without booting the Fresh app.
export function createDevice(
  deps: CreateDeps,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  return createAsset(deps, "device", body, ctx);
}

export const handler = define.handlers({
  GET: (ctx) => listDevices(ctx.state.repositories, ctx.url.searchParams),
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return createDevice(
      ctx.state,
      body.value,
      auditContextFrom(ctx.req, ctx.state.identity),
    );
  },
});
