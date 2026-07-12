// AuditContext for route-initiated writes (routes PRD §3). Phase 4 uses a
// fixed placeholder actor; Phase 5 swaps in the session identity here — one
// function, no re-plumbing of handlers. Source address comes from the proxy
// header when present.
import type { AuditContext } from "../../db/repositories/interfaces/mod.ts";

export function auditContextFrom(req?: Request): AuditContext {
  return {
    actorType: "user",
    actorId: "system", // Phase 5: authenticated identity
    sourceAddress: req?.headers.get("x-forwarded-for") ?? undefined,
  };
}

// Reads a JSON body, mapping malformed JSON to a structured 400 (never a
// thrown driver/parse error).
export async function readJsonBody(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "invalid_json",
            message: "request body is not valid JSON",
          },
        },
        { status: 400 },
      ),
    };
  }
}
