// Ingest API-key auth — Phase 3 STUB (PRD §9.3, non-goal: real auth is Phase 5,
// Prompt 5.1). Push endpoints under routes/api/ingest/ are machine-to-machine:
// an API key in `X-API-Key` or `Authorization: Bearer <key>` maps to a source
// name and a `connector` actor. The key→source map is env-configured:
//
//   DRAGONFLY_INGEST_KEYS="secret-key-1=nessus,secret-key-2=qualys"
//
// No key / unknown key → the route answers 401. /api/health stays the only
// unauthenticated route. Phase 5 replaces this with real API-key roles.

export interface IngestIdentity {
  sourceName: string;
}

// Parses the env mapping once per call site (cheap; a handful of keys).
export function parseIngestKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const source = pair.slice(eq + 1).trim();
    if (key && source) map.set(key, source);
  }
  return map;
}

function extractKey(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return null;
}

// Resolves the caller to a source identity, or null when unauthenticated.
export function resolveIngestIdentity(
  headers: Headers,
  keys: Map<string, string>,
): IngestIdentity | null {
  const key = extractKey(headers);
  if (!key) return null;
  const sourceName = keys.get(key);
  return sourceName ? { sourceName } : null;
}

export function loadIngestKeysFromEnv(): Map<string, string> {
  return parseIngestKeys(Deno.env.get("DRAGONFLY_INGEST_KEYS") ?? undefined);
}
