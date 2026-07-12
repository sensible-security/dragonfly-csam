// Ingest-endpoint tests (ingestion PRD §9.3/§11.2, auth PRD §6). The auth
// middleware owns key resolution (tests/services/http_auth_test.ts); this
// handler receives the resolved connector identity and must fail closed
// without one. A malformed envelope is a 400; an unknown source type is a
// 404. handleIngest is called directly so no Fresh app boot is required.
import { assertEquals } from "@std/assert";
import { handleIngest } from "@/routes/api/ingest/[sourceType].ts";
import { withStack } from "../services/stack.ts";

const CONNECTOR = { kind: "connector", sourceName: "nessus" };
const PAGE = { limit: 100, offset: 0 };

function req(body: unknown): Request {
  return new Request("http://localhost/api/ingest/scanner_json", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

Deno.test("ingest fails closed without a connector identity", async () => {
  await withStack(async (s) => {
    for (
      const identity of [
        undefined,
        // A session identity is not a credential here (PRD Assumption 11).
        { kind: "user", sourceName: undefined },
      ]
    ) {
      const res = await handleIngest({
        sourceType: "scanner_json",
        request: req(ENVELOPE),
        ingestion: s.ingestion,
        registry: s.registry,
        identity,
      });
      assertEquals(res.status, 401);
      assertEquals((await res.json()).error.code, "invalid_api_key");
    }
  });
});

Deno.test("ingest with a connector identity records the source-name actor", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "scanner_json",
      request: req(ENVELOPE),
      ingestion: s.ingestion,
      registry: s.registry,
      identity: CONNECTOR,
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

Deno.test("a malformed envelope is a 400, not a 500", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "scanner_json",
      request: req({ observations: [] }),
      ingestion: s.ingestion,
      registry: s.registry,
      identity: CONNECTOR,
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error.code, "invalid_envelope");
  });
});

Deno.test("an unknown source type is a 404", async () => {
  await withStack(async (s) => {
    const res = await handleIngest({
      sourceType: "made_up",
      request: req(ENVELOPE),
      ingestion: s.ingestion,
      registry: s.registry,
      identity: CONNECTOR,
    });
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error.code, "unknown_source_type");
  });
});
