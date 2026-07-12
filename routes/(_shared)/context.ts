// AuditContext for route-initiated writes (routes PRD §3, auth PRD §7): the
// authenticated identity from ctx.state becomes the audit actor. The
// no-argument form (direct handler calls in tests) falls back to the system
// actor. Source address comes from the proxy header when present.
import type {
  AuditContext,
  AuthIdentity,
} from "../../db/repositories/interfaces/mod.ts";

export function auditContextFrom(
  req?: Request,
  identity?: AuthIdentity,
): AuditContext {
  const sourceAddress = req?.headers.get("x-forwarded-for") ?? undefined;
  if (identity?.kind === "user") {
    return { actorType: "user", actorId: identity.username, sourceAddress };
  }
  if (identity?.kind === "connector") {
    return {
      actorType: "connector",
      actorId: identity.sourceName,
      sourceAddress,
    };
  }
  return { actorType: "system", actorId: "system", sourceAddress };
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
