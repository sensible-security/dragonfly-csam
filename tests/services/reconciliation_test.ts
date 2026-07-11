// Reconciliation engine tests — the crown jewels (PRD §6, §11.2). Outcomes must
// match §6.2 exactly, including the gate case: two sources, same MAC, different
// hostnames → queued, NEVER merged. Also: strong-key auto-merge, ambiguity
// queueing, no-match create-vs-review by connector capability, field precedence
// (manual override immune; equal rank → recency), and last_seen refresh without
// spurious update audits.
import { assert, assertEquals } from "@std/assert";
import { withStack } from "./stack.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";

const USER: AuditContext = { actorType: "user", actorId: "analyst" };
const CONN: AuditContext = { actorType: "connector", actorId: "scanner" };
const PAGE = { limit: 100, offset: 0 };
const SORT = { by: "createdAt", dir: "asc" as const };
const MAC = "00:1A:2B:3C:4D:5E";

function fullDevice(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = {
    kind: "device",
    externalId: "m1",
    observedAt: "2026-07-11T00:00:00Z",
    matchKeys: { hostname: "web01", domain: "corp", hardwareSerial: "SER-1" },
    fields: {
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      owner: "Alice",
      department: "Eng",
      criticality: "high",
      businessImpact: "prod",
    },
  };
  return { ...base, ...overrides };
}

function manual(payload: unknown, sourceName = "manual-entry") {
  return { sourceType: "manual" as const, sourceName, payload };
}
function scanner(observations: unknown[], sourceName = "nessus") {
  return {
    sourceType: "scanner_json" as const,
    sourceName,
    payload: { observations },
  };
}

Deno.test("unique strong key (serial) → auto-merge, one canonical device", async () => {
  await withStack(async (s) => {
    const r1 = await s.ingestion.ingest(manual(fullDevice()), USER);
    assertEquals(r1.reconciliation.created, 1);

    const r2 = await s.ingestion.ingest(
      scanner([{
        kind: "device",
        externalId: "s1",
        observedAt: "2026-07-11T01:00:00Z",
        matchKeys: { hardwareSerial: "SER-1" },
        fields: {},
      }]),
      CONN,
    );
    assertEquals(r2.reconciliation.autoMerged, 1);
    assertEquals((await s.devices.list({}, PAGE)).total, 1);
  });
});

Deno.test("GATE: same MAC, different hostname → queued, NOT merged", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(
      manual(fullDevice({
        matchKeys: { macAddresses: [MAC], hostname: "web01", domain: "corp" },
        interfaces: [{ macAddress: MAC }],
      })),
      USER,
    );

    const r = await s.ingestion.ingest(
      scanner([{
        kind: "device",
        externalId: "s1",
        observedAt: "2026-07-11T01:00:00Z",
        matchKeys: { macAddresses: [MAC], hostname: "app99" },
        fields: {},
      }]),
      CONN,
    );
    assertEquals(r.reconciliation.autoMerged, 0);
    assertEquals(r.reconciliation.queuedForReview, 1);
    assertEquals((await s.devices.list({}, PAGE)).total, 1);

    const q = await s.reviewQueue.list({}, SORT, PAGE);
    assertEquals(q.total, 1);
    assertEquals(q.items[0].reason, "conflicting_field");
    assert(q.items[0].candidates[0].conflicts.includes("hostname"));
  });
});

Deno.test("multiple candidates → queued as ambiguous_match", async () => {
  await withStack(async (s) => {
    // Two canonical devices sharing hostname+domain, no serial.
    const seed = {
      deviceClass: "enterprise_asset" as const,
      enterpriseAssetType: "server" as const,
      environment: "physical" as const,
      hostname: "dup",
      domain: "corp",
      owner: "IT",
      department: "Eng",
      criticality: "low" as const,
      businessImpact: "x",
    };
    await s.devices.create(seed, USER);
    await s.devices.create(seed, USER);

    const r = await s.ingestion.ingest(
      scanner([{
        kind: "device",
        externalId: "s1",
        observedAt: "2026-07-11T01:00:00Z",
        matchKeys: { hostname: "dup", domain: "corp" },
        fields: {},
      }]),
      CONN,
    );
    assertEquals(r.reconciliation.queuedForReview, 1);
    const q = await s.reviewQueue.list({}, SORT, PAGE);
    assertEquals(q.items[0].reason, "ambiguous_match");
    assertEquals(q.items[0].candidates.length, 2);
  });
});

Deno.test("no match + scanner (providesRequiredFields false) → review new_asset", async () => {
  await withStack(async (s) => {
    const r = await s.ingestion.ingest(
      scanner([{
        kind: "device",
        externalId: "s1",
        observedAt: "2026-07-11T01:00:00Z",
        matchKeys: { hostname: "newhost" },
        fields: {
          deviceClass: "enterprise_asset",
          enterpriseAssetType: "server",
          environment: "physical",
        },
      }]),
      CONN,
    );
    assertEquals(r.reconciliation.created, 0);
    assertEquals(r.reconciliation.queuedForReview, 1);
    assertEquals((await s.devices.list({}, PAGE)).total, 0);
    const q = await s.reviewQueue.list({}, SORT, PAGE);
    assertEquals(q.items[0].reason, "new_asset");
  });
});

Deno.test("no match + manual (providesRequiredFields true) → create pending_review", async () => {
  await withStack(async (s) => {
    const r = await s.ingestion.ingest(manual(fullDevice()), USER);
    assertEquals(r.reconciliation.created, 1);
    const d = (await s.devices.list({}, PAGE)).items[0];
    assertEquals(d.status, "pending_review");
    assertEquals(d.owner, "Alice");
  });
});

Deno.test("field precedence: manual override immune to scanner; equal rank → recency", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(
      manual(fullDevice({ observedAt: "2026-07-11T00:00:00Z" })),
      USER,
    );

    // Scanner (rank 50) matches by serial but cannot overwrite manual (100).
    await s.ingestion.ingest(
      scanner([{
        kind: "device",
        externalId: "s1",
        observedAt: "2026-07-11T01:00:00Z",
        matchKeys: { hardwareSerial: "SER-1" },
        fields: { owner: "Bob", environment: "virtual" },
      }]),
      CONN,
    );
    let d = (await s.devices.list({}, PAGE)).items[0];
    assertEquals(d.owner, "Alice");
    assertEquals(d.environment, "physical");

    // A newer manual entry (equal rank 100, later observedAt) wins.
    await s.ingestion.ingest(
      manual(fullDevice({
        observedAt: "2026-07-11T02:00:00Z",
        fields: {
          deviceClass: "enterprise_asset",
          enterpriseAssetType: "server",
          environment: "physical",
          owner: "Carol",
          department: "Eng",
          criticality: "high",
          businessImpact: "prod",
        },
      })),
      USER,
    );
    d = (await s.devices.list({}, PAGE)).items[0];
    assertEquals(d.owner, "Carol");
  });
});

Deno.test("re-observation refreshes without a spurious update audit; merge is audited", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(
      manual(fullDevice({ observedAt: "2026-07-11T00:00:00Z" })),
      USER,
    );
    // Identical values, later clock → auto-merge with no field change.
    await s.ingestion.ingest(
      manual(fullDevice({ observedAt: "2026-07-11T01:00:00Z" })),
      USER,
    );

    const updates = await s.auditLog.query(
      { entityType: "device", action: "update" },
      PAGE,
    );
    assertEquals(updates.total, 0);
    const merges = await s.auditLog.query(
      { entityType: "device", action: "merge" },
      PAGE,
    );
    assert(merges.total >= 1);
  });
});
