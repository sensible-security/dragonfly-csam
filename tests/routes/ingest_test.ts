// Ingest-endpoint tests (PRD §9.3, §11.2). Auth stub: 401 without a key, 200
// with a configured key, actor recorded as `connector`. A malformed envelope is
// a 400; an unknown source type is a 404. handleIngest is called directly so no
// Fresh app boot is required.
import { assertEquals } from "@std/assert";
import { handleIngest } from "@/routes/api/ingest/[sourceType].ts";
import { withStack } from "../services/stack.ts";

const KEYS = new Map([["secret-key-1", "nessus"]]);
const PAGE = { limit: 100, offset: 0 };

function req(headers: Record<string, string>, body: unknown): Request {
  return new Request("http://localhost/api/ingest/scanner_json", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const ENVELOPE = {
  observations: [{
    kind: "device",
    externalId: "nessus-1",
    matchKeys: { hostname: "web01", macAddresses: ["00:1A:2B:3C:4D:5E"] },
    fields: {
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
    },
  }],
};

Deno.test("ingest returns 401 without an API key", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "scanner_json",
      request: req({ "content-type": "application/json" }, ENVELOPE),
      ingestion: s.ingestion,
      registry: s.registry,
      keys: KEYS,
    });
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error.code, "unauthorized");
  });
});

Deno.test("ingest returns 200 with a configured key and records a connector actor", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "scanner_json",
      request: req({ "x-api-key": "secret-key-1" }, ENVELOPE),
      ingestion: s.ingestion,
      registry: s.registry,
      keys: KEYS,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.received, 1);
    assertEquals(body.staged, 1);
    // The scanner cannot supply criticality → the no-match is queued for review.
    assertEquals(body.reconciliation.queuedForReview, 1);

    // The audit actor for the batch is the connector identity (source name).
    const batchAudit = await s.auditLog.query(
      { entityType: "ingestion_batch", action: "create" },
      PAGE,
    );
    assertEquals(batchAudit.items[0].actorType, "connector");
    assertEquals(batchAudit.items[0].actorId, "nessus");
  });
});

Deno.test("ingest accepts a Bearer token equivalently", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "scanner_json",
      request: req({ authorization: "Bearer secret-key-1" }, ENVELOPE),
      ingestion: s.ingestion,
      registry: s.registry,
      keys: KEYS,
    });
    assertEquals(res.status, 200);
  });
});

Deno.test("a malformed envelope is a 400, not a 500", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "scanner_json",
      request: req({ "x-api-key": "secret-key-1" }, { observations: [] }),
      ingestion: s.ingestion,
      registry: s.registry,
      keys: KEYS,
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error.code, "invalid_envelope");
  });
});

Deno.test("an unknown source type is a 404", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "made_up",
      request: req({ "x-api-key": "secret-key-1" }, ENVELOPE),
      ingestion: s.ingestion,
      registry: s.registry,
      keys: KEYS,
    });
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error.code, "unknown_source_type");
  });
});
