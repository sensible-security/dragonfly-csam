// Authenticated push-ingest endpoint (PRD §9.3): POST /api/ingest/{sourceType}.
// Machine-to-machine — auth is an API-key STUB (Phase 5 replaces it). The handler
// resolves the connector by the path segment, authenticates the key → source
// identity, hands the JSON body to the pipeline, and returns the batch result.
// It imports only services + the registry (no SQL/driver) — architecture-boundary
// test covers this. /api/health remains the only unauthenticated route.
import { define } from "../../../utils.ts";
import type { IngestionService } from "../../../services/ingestion_service.ts";
import {
  loadIngestKeysFromEnv,
  resolveIngestIdentity,
} from "../../../services/ingest_auth.ts";
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
  keys: Map<string, string>;
  sourceAddress?: string;
}

// Exported for direct unit testing without booting the Fresh app.
export async function handleIngest(args: HandleIngestArgs): Promise<Response> {
  const { sourceType, request, ingestion, registry, keys } = args;

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

  const identity = resolveIngestIdentity(request.headers, keys);
  if (!identity) {
    return errorResponse(401, "unauthorized", "missing or invalid API key");
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
      keys: loadIngestKeysFromEnv(),
      sourceAddress: ctx.req.headers.get("x-forwarded-for") ?? undefined,
    }),
});
