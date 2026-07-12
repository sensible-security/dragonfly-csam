// /api/admin/api-keys (auth PRD §6, Assumption 6): list + create connector
// keys. Create is the secret's ONLY appearance — listings carry metadata,
// never hashes or secrets.
import { z } from "zod";
import { define } from "../../../../utils.ts";
import type { AuthService } from "../../../../services/auth_service.ts";
import type { AuditContext } from "../../../../db/repositories/interfaces/mod.ts";
import { parseBody } from "../../../(_shared)/body.ts";
import {
  toErrorResponse,
  validationErrorResponse,
} from "../../../(_shared)/errors.ts";
import { auditContextFrom, readJsonBody } from "../../../(_shared)/context.ts";
import { parsePageQuery } from "../../../(_shared)/query.ts";

// The name doubles as the ingest source name (provenance/audit actor).
export const createApiKeySchema = z.object({
  name: z.string().regex(
    /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i,
    "1-64 chars: letters, digits, dot, underscore, hyphen",
  ),
}).strict();

// Exported for direct unit testing without booting the Fresh app.
export async function listApiKeys(
  auth: AuthService,
  search: URLSearchParams,
): Promise<Response> {
  const parsed = parsePageQuery(search);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);
  return Response.json(await auth.listApiKeys(parsed.value));
}

// Exported for direct unit testing without booting the Fresh app.
export async function createApiKey(
  auth: AuthService,
  body: unknown,
  ctx: AuditContext = auditContextFrom(),
): Promise<Response> {
  const parsed = parseBody(createApiKeySchema, body);
  if (!parsed.ok) return validationErrorResponse(parsed.issues);
  try {
    const { apiKey, secret } = await auth.createApiKey(parsed.value, ctx);
    // `key` is shown once, here, and never retrievable again.
    return Response.json({ apiKey, key: secret }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export const handler = define.handlers({
  GET: (ctx) => listApiKeys(ctx.state.services.auth, ctx.url.searchParams),
  POST: async (ctx) => {
    const body = await readJsonBody(ctx.req);
    if (!body.ok) return body.response;
    return createApiKey(
      ctx.state.services.auth,
      body.value,
      auditContextFrom(ctx.req, ctx.state.identity),
    );
  },
});
