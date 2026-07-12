// GET /api/devices/[id] — the composed DeviceDetail DTO (routes PRD §4.1):
// device + interfaces with append-only IP history + installations with
// resolved software + field provenance + the staging records that fed the
// asset. This is the Safeguard 1.1 / ID.AM-05 evidence surface as JSON.
import { define } from "../../../utils.ts";
import type { Repositories } from "../../../db/container.ts";
import { buildDeviceDetail } from "../../(_shared)/detail.ts";
import {
  errorResponse,
  toErrorResponse,
  validationErrorResponse,
} from "../../(_shared)/errors.ts";
import { parseBody, updateDeviceSchema } from "../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function getDevice(
  repositories: Repositories,
  id: string,
): Promise<Response> {
  try {
    const detail = await buildDeviceDetail(repositories, id);
    if (!detail) {
      return errorResponse(404, "not_found", `device not found: ${id}`);
    }
    return Response.json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
}

// PATCH edits mutable fields only — status has its own audited route
// (routes PRD Gate Q1: edits are direct, audited repository operations).
export async function patchDevice(
  repositories: Repositories,
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(updateDeviceSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const device = await repositories.devices.update(id, parsed.value, ctx);
    return Response.json(device);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => getDevice(ctx.state.repositories, ctx.params.id),
  PATCH: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return patchDevice(
      ctx.state.repositories,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req),
    );
  },
});
