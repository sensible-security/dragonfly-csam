// POST /api/devices/[id]/status — the Safeguard 1.2 transition endpoint the
// AssetStatusToggle island drives (routes PRD §4.1). Goes through the audited
// repository setter; every transition writes a status_change audit entry.
import { define } from "../../../../utils.ts";
import type { Repositories } from "../../../../db/container.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { deviceStatusSchema, parseBody } from "../../../(_shared)/body.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";

// Exported for direct unit testing without booting the Fresh app.
export async function setDeviceStatus(
  repositories: Repositories,
  id: string,
  body: unknown,
  ctx = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(deviceStatusSchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);

  try {
    const device = await repositories.devices.setStatus(
      id,
      parsed.value.status,
      ctx,
    );
    return Response.json(device);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return setDeviceStatus(
      ctx.state.repositories,
      ctx.params.id,
      body.value,
      auditContextFrom(ctx.req, ctx.state.identity),
    );
  },
});
