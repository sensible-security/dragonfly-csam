// B1 contract tests: audit write helper + TursoAuditLogRepository.
// Append-only by construction — the concrete class exposes no update/delete.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import { TaxonomyViolationError } from "@/db/repositories/interfaces/mod.ts";
import type { CreateAuditEntry } from "@/db/repositories/interfaces/mod.ts";
import { withTempDb } from "./helpers.ts";

const FULL_ENTRY: CreateAuditEntry = {
  occurredAt: "2026-07-10T12:00:00.000Z",
  actorType: "user",
  actorId: "analyst-1",
  action: "status_change",
  entityType: "device",
  entityId: "device-123",
  beforeJson: '{"status":"authorized"}',
  afterJson: '{"status":"quarantined"}',
  sourceAddress: "203.0.113.7",
};

Deno.test("append persists every audit field and returns the entry", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoAuditLogRepository(db);

    const entry = await repo.append(FULL_ENTRY);

    assert(entry.id.length > 0, "append must assign an id");
    assertEquals(entry.occurredAt, FULL_ENTRY.occurredAt);
    assertEquals(entry.actorType, "user");
    assertEquals(entry.actorId, "analyst-1");
    assertEquals(entry.action, "status_change");
    assertEquals(entry.entityType, "device");
    assertEquals(entry.entityId, "device-123");
    assertEquals(entry.beforeJson, '{"status":"authorized"}');
    assertEquals(entry.afterJson, '{"status":"quarantined"}');
    assertEquals(entry.sourceAddress, "203.0.113.7");

    // Round-trip through the public query surface.
    const page = await repo.query({}, { limit: 10, offset: 0 });
    assertEquals(page.total, 1);
    assertEquals(page.items[0], entry);
  });
});

Deno.test("append defaults occurredAt to now and optional fields to null", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoAuditLogRepository(db);
    const before = new Date().toISOString();

    const entry = await repo.append({
      actorType: "system",
      actorId: "migrator",
      action: "create",
      entityType: "device",
      entityId: "device-9",
    });

    const after = new Date().toISOString();
    assert(
      entry.occurredAt >= before && entry.occurredAt <= after,
      `occurredAt ${entry.occurredAt} not in [${before}, ${after}]`,
    );
    assertEquals(entry.beforeJson, null);
    assertEquals(entry.afterJson, null);
    assertEquals(entry.sourceAddress, null);
  });
});

Deno.test("append translates enum CHECK violations to TaxonomyViolationError", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoAuditLogRepository(db);
    const bogus = {
      ...FULL_ENTRY,
      actorType: "intruder",
    } as unknown as CreateAuditEntry;

    await assertRejects(() => repo.append(bogus), TaxonomyViolationError);
    const page = await repo.query({}, { limit: 10, offset: 0 });
    assertEquals(page.total, 0, "failed append must persist nothing");
  });
});

Deno.test("query filters by every AuditFilter field", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoAuditLogRepository(db);

    await repo.append({
      occurredAt: "2026-07-01T00:00:00.000Z",
      actorType: "user",
      actorId: "alice",
      action: "create",
      entityType: "device",
      entityId: "d-1",
    });
    await repo.append({
      occurredAt: "2026-07-05T00:00:00.000Z",
      actorType: "connector",
      actorId: "csv-import",
      action: "ingest",
      entityType: "source_record",
      entityId: "sr-1",
    });
    await repo.append({
      occurredAt: "2026-07-09T00:00:00.000Z",
      actorType: "user",
      actorId: "alice",
      action: "status_change",
      entityType: "device",
      entityId: "d-2",
    });

    const page = { limit: 10, offset: 0 };
    assertEquals((await repo.query({ entityType: "device" }, page)).total, 2);
    assertEquals((await repo.query({ entityId: "sr-1" }, page)).total, 1);
    assertEquals((await repo.query({ actorId: "alice" }, page)).total, 2);
    assertEquals(
      (await repo.query({ action: "status_change" }, page)).total,
      1,
    );
    assertEquals(
      (await repo.query({ occurredAfter: "2026-07-02T00:00:00.000Z" }, page))
        .total,
      2,
    );
    assertEquals(
      (await repo.query({ occurredBefore: "2026-07-02T00:00:00.000Z" }, page))
        .total,
      1,
    );
    assertEquals(
      (await repo.query(
        { entityType: "device", actorId: "alice", action: "create" },
        page,
      )).total,
      1,
    );
  });
});

Deno.test("query paginates newest-first with a correct total", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoAuditLogRepository(db);
    for (let i = 1; i <= 5; i++) {
      await repo.append({
        occurredAt: `2026-07-0${i}T00:00:00.000Z`,
        actorType: "system",
        actorId: "seeder",
        action: "create",
        entityType: "device",
        entityId: `d-${i}`,
      });
    }

    const first = await repo.query({}, { limit: 2, offset: 0 });
    assertEquals(first.total, 5);
    assertEquals(first.limit, 2);
    assertEquals(first.offset, 0);
    assertEquals(first.items.map((e) => e.entityId), ["d-5", "d-4"]);

    const second = await repo.query({}, { limit: 2, offset: 2 });
    assertEquals(second.items.map((e) => e.entityId), ["d-3", "d-2"]);
    assertEquals(second.total, 5);
  });
});

Deno.test("the repository is append-only: no update or delete members", () => {
  const surface = new Set<string>();
  let proto: object | null = TursoAuditLogRepository.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) surface.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  for (const forbidden of ["update", "delete", "remove", "prune"]) {
    assert(
      !surface.has(forbidden),
      `audit log repository must not expose ${forbidden}()`,
    );
  }
});
