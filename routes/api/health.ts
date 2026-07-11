// Liveness/readiness probe (PLAN C2; AGENTS.md §4.3). Connectivity is verified
// *through the repository layer* — a bounded audit-log read — so this route
// imports no SQL and no driver, only the interface bundle from app state.
import { define } from "../../utils.ts";
import type { Repositories } from "../../db/container.ts";

// Exported for direct unit testing without booting the Fresh app. A single
// cheap read proves the connection is open and the schema is present.
export async function checkHealth(
  repositories: Repositories,
): Promise<Response> {
  try {
    await repositories.auditLog.query({}, { limit: 1, offset: 0 });
    return Response.json({ status: "ok" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: { code: "db_unavailable", message } },
      { status: 503 },
    );
  }
}

export const handler = define.handlers({
  GET: (ctx) => checkHealth(ctx.state.repositories),
});
