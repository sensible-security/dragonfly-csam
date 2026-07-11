// ReviewService tests (PRD §7, §11.2). A human drains the reconciliation queue:
// promote new_asset items with enrichment (criticality + business_impact),
// confirm a candidate (merge), reject noise, and bulk-promote many at once with
// per-item outcomes. Every action closes the item and is audited.
import { assert, assertEquals } from "@std/assert";
import { withStack } from "./stack.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";

const USER: AuditContext = { actorType: "user", actorId: "analyst" };
const CONN: AuditContext = { actorType: "connector", actorId: "scanner" };
const PAGE = { limit: 100, offset: 0 };
const SORT = { by: "createdAt", dir: "asc" as const };

// A scanner-discovered device that knows everything except business criticality.
function discovered(externalId: string, hostname: string) {
  return {
    kind: "device",
    externalId,
    observedAt: "2026-07-11T01:00:00Z",
    matchKeys: { hostname },
    fields: {
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "end_user_device",
      environment: "physical",
      owner: "IT",
      department: "Eng",
    },
  };
}

function scanner(observations: unknown[]) {
  return {
    sourceType: "scanner_json" as const,
    sourceName: "nessus",
    payload: { observations },
  };
}

Deno.test("createNew promotes a new_asset item with enrichment to pending_review", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(scanner([discovered("s1", "disc1")]), CONN);
    const item =
      (await s.review.list({ reason: "new_asset" }, SORT, PAGE)).items[0];

    await s.review.createNew(item.id, {
      criticality: "medium",
      businessImpact: "newly discovered on the network",
    }, USER);

    const d = (await s.devices.list({}, PAGE)).items[0];
    assertEquals(d.hostname, "disc1");
    assertEquals(d.status, "pending_review");
    assertEquals(d.criticality, "medium");

    const reloaded = await s.reviewQueue.getById(item.id);
    assertEquals(reloaded?.status, "created_new");
    // The promotion wrote a create audit for the device.
    const created = await s.auditLog.query({
      entityType: "device",
      action: "create",
    }, PAGE);
    assertEquals(created.total, 1);
  });
});

Deno.test("bulkCreateNew promotes many; reports per-item failures without aborting", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(
      scanner([
        discovered("s1", "d1"),
        discovered("s2", "d2"),
        discovered("s3", "d3"),
      ]),
      CONN,
    );
    const items =
      (await s.review.list({ reason: "new_asset" }, SORT, PAGE)).items;
    assertEquals(items.length, 3);
    const ids = items.map((i) => i.id);

    const enrichment = {
      criticality: "low" as const,
      businessImpact: "bulk enriched",
    };
    const first = await s.review.bulkCreateNew(ids, enrichment, USER);
    assertEquals(first.succeeded.length, 3);
    assertEquals(first.failed.length, 0);
    assertEquals((await s.devices.list({}, PAGE)).total, 3);
    // Each promotion wrote its own create audit entry.
    assertEquals(
      (await s.auditLog.query({ entityType: "device", action: "create" }, PAGE))
        .total,
      3,
    );

    // Re-running on now-resolved items fails per-item, not wholesale.
    const second = await s.review.bulkCreateNew([ids[0]], enrichment, USER);
    assertEquals(second.succeeded.length, 0);
    assertEquals(second.failed.length, 1);
    assertEquals(second.failed[0].code, "not_pending");
  });
});

Deno.test("reject closes the item and marks the staged record rejected", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(scanner([discovered("s1", "noise")]), CONN);
    const item =
      (await s.review.list({ reason: "new_asset" }, SORT, PAGE)).items[0];

    await s.review.reject(item.id, "not our asset", USER);
    const reloaded = await s.reviewQueue.getById(item.id);
    assertEquals(reloaded?.status, "rejected");
    assertEquals((await s.devices.list({}, PAGE)).total, 0);
    // Default (pending) listing no longer shows it.
    assertEquals((await s.review.list({}, SORT, PAGE)).total, 0);
  });
});

Deno.test("merge confirms a human-chosen candidate and audits the link", async () => {
  await withStack(async (s) => {
    const MAC = "00:1A:2B:3C:4D:5E";
    await s.ingestion.ingest(
      {
        sourceType: "manual",
        sourceName: "manual-entry",
        payload: {
          kind: "device",
          externalId: "m1",
          observedAt: "2026-07-11T00:00:00Z",
          matchKeys: { macAddresses: [MAC], hostname: "web01" },
          interfaces: [{ macAddress: MAC }],
          fields: {
            deviceClass: "enterprise_asset",
            enterpriseAssetType: "server",
            environment: "physical",
            owner: "IT",
            department: "Eng",
            criticality: "high",
            businessImpact: "prod",
          },
        },
      },
      USER,
    );
    // Same MAC, different hostname → conflicting_field review with a candidate.
    await s.ingestion.ingest(
      scanner([{
        kind: "device",
        externalId: "s1",
        observedAt: "2026-07-11T01:00:00Z",
        matchKeys: { macAddresses: [MAC], hostname: "app99" },
        fields: {},
      }]),
      CONN,
    );
    const item = (await s.review.list({}, SORT, PAGE)).items[0];
    assertEquals(item.reason, "conflicting_field");
    const target = item.candidates[0].entityId;

    await s.review.merge(item.id, target, USER);
    const reloaded = await s.reviewQueue.getById(item.id);
    assertEquals(reloaded?.status, "merged");
    const merges = await s.auditLog.query(
      { entityType: "device", entityId: target, action: "merge" },
      PAGE,
    );
    assert(merges.total >= 1);
  });
});

Deno.test("list filters and sorts pass through to the queue repository", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(
      scanner([discovered("s1", "web-alpha"), discovered("s2", "db-beta")]),
      CONN,
    );
    const web = await s.review.list(
      { attributeContains: { field: "hostname", value: "web" } },
      SORT,
      PAGE,
    );
    assertEquals(web.total, 1);
    assertEquals(web.items[0].attributes.hostname, "web-alpha");
  });
});
