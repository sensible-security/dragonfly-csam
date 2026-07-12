// Review-queue API handler tests (routes PRD §4.4): list with filter/sort/
// paginate, item detail, merge / create-new / reject resolutions (audited),
// not_pending → 409, and bulk-create-new returning per-item outcomes (200
// even on partial failure — ingestion PRD gate decision 1).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type Container, createContainer } from "@/db/container.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";
import { listReviewQueue } from "@/routes/api/review-queue/index.ts";
import { getReviewItem } from "@/routes/api/review-queue/[id].ts";
import { mergeReviewItem } from "@/routes/api/review-queue/[id]/merge.ts";
import { createNewFromReviewItem } from "@/routes/api/review-queue/[id]/create-new.ts";
import { rejectReviewItem } from "@/routes/api/review-queue/[id]/reject.ts";
import { bulkCreateNew } from "@/routes/api/review-queue/bulk-create-new.ts";

const CTX: AuditContext = { actorType: "user", actorId: "analyst-1" };

function search(qs: string): URLSearchParams {
  return new URL(`http://localhost/x?${qs}`).searchParams;
}

async function withContainer(
  fn: (container: Container) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-review-" });
  const container = await createContainer({ dbPath: join(dir, "test.db") });
  try {
    await fn(container);
  } finally {
    await container.close();
    await Deno.remove(dir, { recursive: true });
  }
}

// Stages an observation and queues it, mirroring what reconciliation does
// for a new_asset that lacks required fields.
async function seedReviewItem(
  container: Container,
  hostname: string,
  candidates: { entityId: string }[] = [],
) {
  const { sourceRecords, reviewQueue } = container.repositories;
  const source = await sourceRecords.getSourceByName("nmap-lab") ??
    await sourceRecords.registerSource(
      { sourceType: "scanner_json", name: "nmap-lab", precedence: 50 },
      CTX,
    );
  const observation = {
    kind: "device",
    externalId: `obs-${hostname}`,
    observedAt: "2026-07-01T00:00:00.000Z",
    matchKeys: { hostname, domain: "corp.local" },
    fields: {
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname,
      domain: "corp.local",
    },
  };
  const record = await sourceRecords.upsertObservation({
    sourceId: source.id,
    externalId: observation.externalId,
    entityKind: "device",
    rawPayload: JSON.stringify(observation),
    normalizedPayload: JSON.stringify(observation),
    observedAt: observation.observedAt,
  }, CTX);
  await sourceRecords.setReconciliationOutcome(record.id, "in_review");
  const item = await reviewQueue.enqueue({
    sourceRecordId: record.id,
    entityKind: "device",
    reason: candidates.length > 0 ? "ambiguous_match" : "new_asset",
    confidence: candidates.length > 0 ? "ambiguous" : "medium",
    candidates: candidates.map((c) => ({
      entityId: c.entityId,
      matchedKey: "hostname_domain" as const,
      score: 1,
      conflicts: [],
    })),
    attributes: { hostname },
  }, CTX);
  return { item, record };
}

Deno.test("GET /api/review-queue lists pending items with filters + sort", async () => {
  await withContainer(async (container) => {
    await seedReviewItem(container, "q-01");
    await seedReviewItem(container, "q-02");

    const res = await listReviewQueue(container.services, search(""));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.total, 2);

    const sorted = await (await listReviewQueue(
      container.services,
      search("sortBy=hostname&sortDir=desc"),
    )).json();
    assertEquals(sorted.items[0].attributes.hostname, "q-02");

    const bad = await listReviewQueue(
      container.services,
      search("confidence=bogus"),
    );
    assertEquals(bad.status, 400);
  });
});

Deno.test("GET /api/review-queue/[id] returns detail or 404", async () => {
  await withContainer(async (container) => {
    const { item } = await seedReviewItem(container, "q-03");
    const res = await getReviewItem(container.repositories, item.id);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).id, item.id);

    const missing = await getReviewItem(
      container.repositories,
      crypto.randomUUID(),
    );
    assertEquals(missing.status, 404);
  });
});

Deno.test("merge resolves the item onto the chosen candidate and audits", async () => {
  await withContainer(async (container) => {
    const target = await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname: "q-04",
      domain: "corp.local",
      owner: "IT",
      department: "Eng",
      criticality: "low",
      businessImpact: "test",
    }, CTX);
    const { item } = await seedReviewItem(container, "q-04", [
      { entityId: target.id },
    ]);

    const res = await mergeReviewItem(container, item.id, {
      targetEntityId: target.id,
    }, CTX);
    assertEquals(res.status, 200);

    const resolved = await container.repositories.reviewQueue.getById(item.id);
    assertEquals(resolved?.status, "merged");

    const audit = await container.repositories.auditLog.query(
      { entityType: "device", entityId: target.id, action: "merge" },
      { limit: 10, offset: 0 },
    );
    assertEquals(audit.total, 1);

    // Second resolution attempt → 409 not_pending.
    const again = await mergeReviewItem(container, item.id, {
      targetEntityId: target.id,
    }, CTX);
    assertEquals(again.status, 409);
    assertEquals((await again.json()).error.code, "not_pending");
  });
});

Deno.test("create-new promotes with enrichment; missing enrichment is 400", async () => {
  await withContainer(async (container) => {
    const { item, record } = await seedReviewItem(container, "q-05");

    const invalid = await createNewFromReviewItem(container, item.id, {
      criticality: "high",
    }, CTX);
    assertEquals(invalid.status, 400);

    const res = await createNewFromReviewItem(container, item.id, {
      criticality: "high",
      businessImpact: "edge scanner find",
      owner: "IT Ops",
      department: "Engineering",
    }, CTX);
    assertEquals(res.status, 200);

    const after = await container.repositories.sourceRecords.getById(record.id);
    assertEquals(after?.reconciliationStatus, "created");
    const device = await container.repositories.devices.getById(
      after?.matchedEntityId ?? "",
    );
    assertEquals(device?.hostname, "q-05");
    assertEquals(device?.status, "pending_review");
  });
});

Deno.test("reject closes the item with a reason", async () => {
  await withContainer(async (container) => {
    const { item, record } = await seedReviewItem(container, "q-06");
    const res = await rejectReviewItem(container, item.id, {
      reason: "duplicate scanner artifact",
    }, CTX);
    assertEquals(res.status, 200);

    const resolved = await container.repositories.reviewQueue.getById(item.id);
    assertEquals(resolved?.status, "rejected");
    const after = await container.repositories.sourceRecords.getById(record.id);
    assertEquals(after?.reconciliationStatus, "rejected");
  });
});

Deno.test("bulk-create-new reports per-item outcomes (200 on partial failure)", async () => {
  await withContainer(async (container) => {
    const { item: pending } = await seedReviewItem(container, "q-07");
    const { item: resolved } = await seedReviewItem(container, "q-08");
    await rejectReviewItem(container, resolved.id, { reason: "dup" }, CTX);

    const res = await bulkCreateNew(container, {
      itemIds: [pending.id, resolved.id],
      enrichment: {
        criticality: "medium",
        businessImpact: "bulk import",
        owner: "IT Ops",
        department: "Engineering",
      },
    }, CTX);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.succeeded, [pending.id]);
    assertEquals(body.failed.length, 1);
    assertEquals(body.failed[0].itemId, resolved.id);
    assertEquals(body.failed[0].code, "not_pending");
  });
});
