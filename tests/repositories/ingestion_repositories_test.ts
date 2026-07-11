// Contract tests for the Phase-3 repository surface: match-key finders on the
// device/software repositories, source-record reconciliation stamping +
// precedence, the ingestion-batch/quarantine repository, and the review-queue
// repository (filter/sort/paginate + audited resolve). Temp-file DB per test.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import { TursoDeviceRepository } from "@/db/repositories/turso/device_repository.ts";
import { TursoSoftwareRepository } from "@/db/repositories/turso/software_repository.ts";
import { TursoSourceRecordRepository } from "@/db/repositories/turso/source_record_repository.ts";
import { TursoIngestionBatchRepository } from "@/db/repositories/turso/ingestion_batch_repository.ts";
import { TursoReviewQueueRepository } from "@/db/repositories/turso/review_queue_repository.ts";
import {
  type AuditContext,
  type CreateDevice,
  NotFoundError,
} from "@/db/repositories/interfaces/mod.ts";
import { withTempDb } from "./helpers.ts";

const CTX: AuditContext = { actorType: "connector", actorId: "test" };
const PAGE = { limit: 50, offset: 0 };

function deviceInput(overrides: Partial<CreateDevice> = {}): CreateDevice {
  return {
    deviceClass: "enterprise_asset",
    enterpriseAssetType: "server",
    environment: "physical",
    hostname: "host",
    owner: "IT",
    department: "Eng",
    criticality: "low",
    businessImpact: "test",
    ...overrides,
  };
}

Deno.test("device finders resolve each match key; MAC join finds by interface", async () => {
  await withTempDb(async (db) => {
    const devices = new TursoDeviceRepository(db);

    const a = await devices.create(
      deviceInput({
        hostname: "web01",
        domain: "corp",
        cloudInstanceId: "i-aaa",
        hardwareSerial: "SER-1",
      }),
      CTX,
    );
    await devices.create(
      deviceInput({
        hostname: "web02",
        domain: "corp",
        cloudInstanceId: "i-bbb",
      }),
      CTX,
    );
    await devices.addInterface(a.id, { macAddress: "00:1A:2B:3C:4D:5E" }, CTX);

    assertEquals(
      (await devices.findByCloudInstanceId("i-aaa")).map((d) => d.id),
      [a.id],
    );
    assertEquals((await devices.findByCloudInstanceId("i-zzz")).length, 0);
    assertEquals(
      (await devices.findByHardwareSerial("SER-1")).map((d) => d.id),
      [a.id],
    );
    // MAC finder normalizes input notation and joins network_interfaces.
    assertEquals(
      (await devices.findByMacAddresses(["001a.2b3c.4d5e"])).map((d) => d.id),
      [a.id],
    );
    assertEquals((await devices.findByMacAddresses([])).length, 0);
    assertEquals(
      (await devices.findByHostnameDomain("web01", "corp")).map((d) => d.id),
      [a.id],
    );
    assertEquals((await devices.findByHostnameDomain("web01", null)).length, 0);
  });
});

Deno.test("findByHostnameDomain returns multiple candidates when hostname is reused", async () => {
  await withTempDb(async (db) => {
    const devices = new TursoDeviceRepository(db);
    await devices.create(deviceInput({ hostname: "dup", domain: "corp" }), CTX);
    await devices.create(deviceInput({ hostname: "dup", domain: "corp" }), CTX);
    assertEquals((await devices.findByHostnameDomain("dup", "corp")).length, 2);
  });
});

Deno.test("software findByIdentity matches the exact (title, publisher, version)", async () => {
  await withTempDb(async (db) => {
    const software = new TursoSoftwareRepository(db);
    const sw = await software.create({
      title: "OpenSSL",
      publisher: "OpenSSL Project",
      version: "3.0.2",
      softwareType: "application",
      componentType: "library",
      businessPurpose: "crypto",
      criticality: "high",
      businessImpact: "tls",
    }, CTX);
    const found = await software.findByIdentity(
      "OpenSSL",
      "OpenSSL Project",
      "3.0.2",
    );
    assertEquals(found?.id, sw.id);
    assertEquals(
      await software.findByIdentity("OpenSSL", "OpenSSL Project", "9.9.9"),
      null,
    );
  });
});

Deno.test("getSourceById returns precedence; registerSource honors it", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSourceRecordRepository(db);
    const src = await repo.registerSource(
      { sourceType: "scanner_json", name: "nessus", precedence: 50 },
      CTX,
    );
    assertEquals(src.precedence, 50);
    const byId = await repo.getSourceById(src.id);
    assertEquals(byId?.precedence, 50);
    assertEquals(await repo.getSourceById("nope"), null);

    const manual = await repo.registerSource(
      { sourceType: "manual", name: "manual-entry", precedence: 100 },
      CTX,
    );
    assertEquals((await repo.getSourceById(manual.id))?.precedence, 100);
  });
});

Deno.test("setReconciliationOutcome stamps outcome; rejects unknown record", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSourceRecordRepository(db);
    const src = await repo.registerSource(
      { sourceType: "csv_import", name: "csv" },
      CTX,
    );
    const rec = await repo.upsertObservation({
      sourceId: src.id,
      externalId: "ext-1",
      entityKind: "device",
      rawPayload: "{}",
      normalizedPayload: "{}",
      observedAt: new Date().toISOString(),
    }, CTX);

    await repo.setReconciliationOutcome(
      rec.id,
      "auto_merged",
      "device",
      "dev-123",
    );
    const stmt = await db.prepare(
      "SELECT reconciliation_status, matched_entity_type, matched_entity_id, reconciled_at FROM source_records WHERE id = ?",
    );
    const got = await stmt.get(rec.id) as {
      reconciliation_status: string;
      matched_entity_type: string;
      matched_entity_id: string;
      reconciled_at: string;
    };
    assertEquals(got.reconciliation_status, "auto_merged");
    assertEquals(got.matched_entity_type, "device");
    assertEquals(got.matched_entity_id, "dev-123");
    assert(got.reconciled_at.length > 0);

    await assertRejects(
      () => repo.setReconciliationOutcome("no-such", "rejected"),
      NotFoundError,
    );
  });
});

Deno.test("ingestion batch: open, record errors, finalize with audited counts", async () => {
  await withTempDb(async (db) => {
    const sources = new TursoSourceRecordRepository(db);
    const batches = new TursoIngestionBatchRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const src = await sources.registerSource({
      sourceType: "csv_import",
      name: "csv",
    }, CTX);

    const batch = await batches.open({
      sourceId: src.id,
      connectorId: "csv_import",
    }, CTX);
    assertEquals(batch.status, "running");
    assertEquals(batch.actorId, "test");

    await batches.recordError({
      batchId: batch.id,
      rowRef: "7",
      externalId: null,
      rawRow: "bad,row",
      issues: [{
        field: "criticality",
        code: "invalid_enum",
        message: "bad criticality",
      }],
    });
    const errors = await batches.listErrors(batch.id);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].issues[0].field, "criticality");
    assertEquals(errors[0].rawRow, "bad,row");

    const finalized = await batches.finalize(batch.id, {
      status: "completed",
      totalRows: 10,
      stagedCount: 9,
      quarantinedCount: 1,
    }, CTX);
    assertEquals(finalized.status, "completed");
    assertEquals(finalized.stagedCount, 9);
    assertEquals(finalized.quarantinedCount, 1);
    assert(finalized.finishedAt !== null);

    const openAudit = await audit.query(
      { entityType: "ingestion_batch", entityId: batch.id, action: "create" },
      PAGE,
    );
    assertEquals(openAudit.total, 1);
    const finAudit = await audit.query(
      { entityType: "ingestion_batch", entityId: batch.id, action: "update" },
      PAGE,
    );
    assertEquals(finAudit.total, 1);

    await assertRejects(
      () =>
        batches.finalize("nope", {
          status: "failed",
          totalRows: 0,
          stagedCount: 0,
          quarantinedCount: 0,
        }, CTX),
      NotFoundError,
    );
  });
});

Deno.test("review queue: enqueue, filter, sort, paginate, and audited resolve", async () => {
  await withTempDb(async (db) => {
    const sources = new TursoSourceRecordRepository(db);
    const queue = new TursoReviewQueueRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const src = await sources.registerSource({
      sourceType: "scanner_json",
      name: "nessus",
    }, CTX);

    async function stage(externalId: string): Promise<string> {
      const rec = await sources.upsertObservation({
        sourceId: src.id,
        externalId,
        entityKind: "device",
        rawPayload: "{}",
        normalizedPayload: "{}",
        observedAt: new Date().toISOString(),
      }, CTX);
      return rec.id;
    }

    const r1 = await queue.enqueue({
      sourceRecordId: await stage("e1"),
      entityKind: "device",
      reason: "new_asset",
      confidence: "medium",
      candidates: [],
      attributes: { hostname: "web01", department: "Sales" },
    }, CTX);
    await queue.enqueue({
      sourceRecordId: await stage("e2"),
      entityKind: "device",
      reason: "ambiguous_match",
      confidence: "ambiguous",
      candidates: [{
        entityId: "d1",
        matchedKey: "mac_address",
        score: 0.5,
        conflicts: ["hostname"],
      }],
      attributes: { hostname: "app99", department: "Eng" },
    }, CTX);
    await queue.enqueue({
      sourceRecordId: await stage("e3"),
      entityKind: "software",
      reason: "new_asset",
      confidence: "high",
      candidates: [],
      attributes: { hostname: "web-db", department: "Sales" },
    }, CTX);

    // Default status filter is pending → all three.
    assertEquals(
      (await queue.list({}, { by: "createdAt", dir: "asc" }, PAGE)).total,
      3,
    );
    // entityKind filter.
    assertEquals(
      (await queue.list({ entityKind: "software" }, {
        by: "createdAt",
        dir: "asc",
      }, PAGE)).total,
      1,
    );
    // reason filter.
    assertEquals(
      (await queue.list({ reason: "new_asset" }, {
        by: "createdAt",
        dir: "asc",
      }, PAGE)).total,
      2,
    );
    // confidence filter.
    assertEquals(
      (await queue.list({ confidence: "ambiguous" }, {
        by: "createdAt",
        dir: "asc",
      }, PAGE)).total,
      1,
    );
    // sourceId filter (all share one source).
    assertEquals(
      (await queue.list(
        { sourceId: src.id },
        { by: "createdAt", dir: "asc" },
        PAGE,
      )).total,
      3,
    );
    // attributeContains (case-insensitive) — hostnames containing "web".
    const web = await queue.list(
      { attributeContains: { field: "hostname", value: "WEB" } },
      { by: "createdAt", dir: "asc" },
      PAGE,
    );
    assertEquals(web.total, 2);

    // Sort by projected attribute (department) ascending.
    const byDept = await queue.list({}, { by: "department", dir: "asc" }, PAGE);
    assertEquals(byDept.items[0].attributes.department, "Eng");
    // Sort by confidence descending → high first.
    const byConf = await queue.list(
      {},
      { by: "confidence", dir: "desc" },
      PAGE,
    );
    assertEquals(byConf.items[0].confidence, "high");

    // Pagination.
    const p1 = await queue.list({}, { by: "createdAt", dir: "asc" }, {
      limit: 2,
      offset: 0,
    });
    assertEquals(p1.items.length, 2);
    assertEquals(p1.total, 3);
    const p2 = await queue.list({}, { by: "createdAt", dir: "asc" }, {
      limit: 2,
      offset: 2,
    });
    assertEquals(p2.items.length, 1);

    // Resolve writes a status_change audit entry and closes the item.
    const resolved = await queue.resolve(r1.id, {
      status: "merged",
      resolvedBy: "analyst",
    }, {
      actorType: "user",
      actorId: "analyst",
    });
    assertEquals(resolved.status, "merged");
    assertEquals(resolved.resolvedBy, "analyst");
    assert(resolved.resolvedAt !== null);
    const resolveAudit = await audit.query(
      {
        entityType: "review_queue_item",
        entityId: r1.id,
        action: "status_change",
      },
      PAGE,
    );
    assertEquals(resolveAudit.total, 1);
    // The merged item drops out of the default (pending) listing.
    assertEquals(
      (await queue.list({}, { by: "createdAt", dir: "asc" }, PAGE)).total,
      2,
    );
  });
});
