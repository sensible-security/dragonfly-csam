// Authenticated push-ingest endpoint (ingestion PRD §9.3, auth PRD §6):
// POST /api/ingest/{sourceType}. Machine-to-machine — the auth middleware
// resolves the API key to a connector identity (DB-backed keys, auth PRD
// Assumption 6) before this handler runs; a session cookie is not a
// credential here. The handler resolves the connector by the path segment,
// hands the JSON body to the pipeline, and returns the batch result. It
// imports only services + the registry (no SQL/driver) — architecture-
// boundary test covers this.
import { define } from "../../../utils.ts";
import type { IngestionService } from "../../../services/ingestion_service.ts";
import {
  type ConnectorRegistry,
  InvalidEnvelopeError,
  type SourceType,
} from "../../../connectors/mod.ts";

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

export interface HandleIngestArgs {
  sourceType: string;
  request: Request;
  ingestion: IngestionService;
  registry: ConnectorRegistry;
  // The connector identity resolved by the auth middleware; its sourceName is
  // the API key's name (provenance + audit actor).
  identity?: { kind: string; sourceName?: string };
  sourceAddress?: string;
}

// Exported for direct unit testing without booting the Fresh app.
export async function handleIngest(args: HandleIngestArgs): Promise<Response> {
  const { sourceType, request, ingestion, registry, identity } = args;

  const connector = registry.get(sourceType as SourceType);
  if (!connector) {
    return errorResponse(
      404,
      "unknown_source_type",
      `no connector for "${sourceType}"`,
    );
  }
  if (connector.capabilities.mode !== "push") {
    return errorResponse(
      405,
      "not_push_endpoint",
      `${sourceType} is not a push ingest endpoint`,
    );
  }

  // Defense in depth: the middleware guarantees a connector identity here,
  // but direct calls (tests) and future wiring mistakes must fail closed.
  if (identity?.kind !== "connector" || !identity.sourceName) {
    return errorResponse(401, "invalid_api_key", "missing or invalid API key");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "request body is not valid JSON");
  }

  try {
    const result = await ingestion.ingest({
      sourceType: sourceType as SourceType,
      sourceName: identity.sourceName,
      payload: body,
    }, {
      actorType: "connector",
      actorId: identity.sourceName,
      sourceAddress: args.sourceAddress,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof InvalidEnvelopeError) {
      return Response.json(
        {
          error: {
            code: "invalid_envelope",
            message: err.message,
            issues: err.issues,
          },
        },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, "ingest_failed", message);
  }
}

export const handler = define.handlers({
  POST: (ctx) =>
    handleIngest({
      sourceType: ctx.params.sourceType,
      request: ctx.req,
      ingestion: ctx.state.services.ingestion,
      registry: ctx.state.registry,
      identity: ctx.state.identity,
      sourceAddress: ctx.req.headers.get("x-forwarded-for") ?? undefined,
    }),
});
