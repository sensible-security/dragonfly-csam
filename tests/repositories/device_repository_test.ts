// B2 contract tests: TursoDeviceRepository (Safeguards 1.1, 1.2; ID.AM-05).
// Covers the cases DEVELOPMENT_PLAN Prompt 2.2 names explicitly: IP history
// append semantics, authorized→quarantined with audit entry, and rejection
// of records missing criticality/business_impact.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import { TursoDeviceRepository } from "@/db/repositories/turso/device_repository.ts";
import {
  type AuditContext,
  type CreateDevice,
  DuplicateAssetError,
  MissingCriticalityError,
  NotFoundError,
  TaxonomyViolationError,
} from "@/db/repositories/interfaces/mod.ts";
import { withTempDb } from "./helpers.ts";

const CTX: AuditContext = {
  actorType: "user",
  actorId: "analyst-1",
  sourceAddress: "203.0.113.7",
};

const PAGE = { limit: 50, offset: 0 };

function validInput(overrides: Partial<CreateDevice> = {}): CreateDevice {
  return {
    deviceClass: "enterprise_asset",
    enterpriseAssetType: "server",
    environment: "physical",
    status: "authorized",
    hostname: "web-01",
    owner: "IT Ops",
    department: "Engineering",
    criticality: "high",
    businessImpact: "primary web tier",
    ...overrides,
  };
}

Deno.test("create persists a full device and writes a create audit entry", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const audit = new TursoAuditLogRepository(db);

    const device = await repo.create(
      validInput({
        enterpriseAssetType: "end_user_device",
        endUserDeviceSubtype: "mobile",
        environment: "cloud",
        domain: "corp.example.com",
        hardwareSerial: "SN-42",
        cloudInstanceId: "i-0abc",
        notes: "fixture",
      }),
      CTX,
    );

    assert(device.id.length > 0);
    assertEquals(device.deviceClass, "enterprise_asset");
    assertEquals(device.enterpriseAssetType, "end_user_device");
    assertEquals(device.endUserDeviceSubtype, "mobile");
    assertEquals(device.environment, "cloud");
    assertEquals(device.status, "authorized");
    assertEquals(device.hostname, "web-01");
    assertEquals(device.domain, "corp.example.com");
    assertEquals(device.hardwareSerial, "SN-42");
    assertEquals(device.cloudInstanceId, "i-0abc");
    assertEquals(device.owner, "IT Ops");
    assertEquals(device.department, "Engineering");
    assertEquals(device.criticality, "high");
    assertEquals(device.businessImpact, "primary web tier");
    assertEquals(device.notes, "fixture");
    assertEquals(await repo.getById(device.id), device);

    const entries = await audit.query(
      { entityType: "device", entityId: device.id, action: "create" },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assertEquals(entries.items[0].actorId, "analyst-1");
    assertEquals(entries.items[0].beforeJson, null);
    assertEquals(entries.items[0].sourceAddress, "203.0.113.7");
    const after = JSON.parse(entries.items[0].afterJson ?? "{}");
    assertEquals(after.hostname, "web-01");
  });
});

Deno.test("create defaults status to pending_review", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const device = await repo.create(validInput({ status: undefined }), CTX);
    assertEquals(device.status, "pending_review");
  });
});

Deno.test("create is atomic: audit-write failure leaves no device row", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    // An out-of-enum actor type fails the audit_log CHECK *after* the device
    // INSERT has succeeded inside the same transaction.
    const bogusCtx = {
      actorType: "intruder",
      actorId: "x",
    } as unknown as AuditContext;

    await assertRejects(() => repo.create(validInput(), bogusCtx));
    const page = await repo.list({}, PAGE);
    assertEquals(page.total, 0, "rolled-back create must leave no device");
  });
});

Deno.test("create rejects missing or empty criticality/business_impact", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    // Untyped callers can bypass compile-time required fields (PLAN dec. 6).
    const cases = [
      { ...validInput(), criticality: undefined },
      { ...validInput(), criticality: "" },
      { ...validInput(), businessImpact: undefined },
      { ...validInput(), businessImpact: "  " },
    ] as unknown as CreateDevice[];

    for (const input of cases) {
      await assertRejects(
        () => repo.create(input, CTX),
        MissingCriticalityError,
      );
    }
    assertEquals((await repo.list({}, PAGE)).total, 0);
  });
});

Deno.test("create translates taxonomy violations, never leaks driver errors", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);

    // Out-of-enum value smuggled past the type system.
    await assertRejects(
      () =>
        repo.create(
          validInput({
            environment: "orbital",
          } as unknown as Partial<CreateDevice>),
          CTX,
        ),
      TaxonomyViolationError,
    );
    // Hierarchy: removable media must not carry an enterprise asset type.
    await assertRejects(
      () =>
        repo.create(
          validInput({
            deviceClass: "removable_media",
            enterpriseAssetType: "server",
          }),
          CTX,
        ),
      TaxonomyViolationError,
    );
    assertEquals((await repo.list({}, PAGE)).total, 0);
  });
});

Deno.test("getById returns null for an unknown id", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    assertEquals(await repo.getById("no-such-device"), null);
  });
});

Deno.test("update patches fields and writes an update audit entry with a diff", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const device = await repo.create(validInput(), CTX);

    const updated = await repo.update(
      device.id,
      { hostname: "web-02", criticality: "mission_critical" },
      CTX,
    );

    assertEquals(updated.hostname, "web-02");
    assertEquals(updated.criticality, "mission_critical");
    assertEquals(updated.department, "Engineering", "untouched field kept");
    assert(updated.updatedAt >= device.updatedAt);

    const entries = await audit.query(
      { entityType: "device", entityId: device.id, action: "update" },
      PAGE,
    );
    assertEquals(entries.total, 1);
    const before = JSON.parse(entries.items[0].beforeJson ?? "{}");
    const after = JSON.parse(entries.items[0].afterJson ?? "{}");
    assertEquals(before.hostname, "web-01");
    assertEquals(after.hostname, "web-02");
  });
});

Deno.test("update re-validates hierarchy rules", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const server = await repo.create(validInput(), CTX);

    // A server may not carry an end-user-device subtype.
    await assertRejects(
      () => repo.update(server.id, { endUserDeviceSubtype: "portable" }, CTX),
      TaxonomyViolationError,
    );
    assertEquals((await repo.getById(server.id))?.endUserDeviceSubtype, null);
  });
});

Deno.test("update throws NotFoundError for an unknown id", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    await assertRejects(
      () => repo.update("ghost", { hostname: "x" }, CTX),
      NotFoundError,
    );
  });
});

Deno.test("setStatus authorized→quarantined persists and audits the transition", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const device = await repo.create(validInput({ status: "authorized" }), CTX);

    const quarantined = await repo.setStatus(device.id, "quarantined", CTX);

    assertEquals(quarantined.status, "quarantined");
    assertEquals((await repo.getById(device.id))?.status, "quarantined");

    const entries = await audit.query(
      { entityType: "device", entityId: device.id, action: "status_change" },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assertEquals(
      JSON.parse(entries.items[0].beforeJson ?? "{}").status,
      "authorized",
    );
    assertEquals(
      JSON.parse(entries.items[0].afterJson ?? "{}").status,
      "quarantined",
    );
  });
});

Deno.test("setStatus throws NotFoundError for an unknown id", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    await assertRejects(
      () => repo.setStatus("ghost", "quarantined", CTX),
      NotFoundError,
    );
  });
});

Deno.test("addInterface normalizes MACs and enforces per-device uniqueness", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const device = await repo.create(validInput(), CTX);

    const iface = await repo.addInterface(
      device.id,
      { macAddress: "aa-bb-cc-00-11-22", interfaceName: "eth0" },
      CTX,
    );
    assertEquals(iface.macAddress, "AA:BB:CC:00:11:22");
    assertEquals(iface.deviceId, device.id);
    assertEquals(iface.interfaceName, "eth0");

    // Same MAC in a different notation is still a duplicate on this device.
    await assertRejects(
      () => repo.addInterface(device.id, { macAddress: "aabb.cc00.1122" }, CTX),
      DuplicateAssetError,
    );

    // ...but fine on a different device (MAC is not globally unique).
    const other = await repo.create(validInput({ hostname: "web-03" }), CTX);
    await repo.addInterface(other.id, { macAddress: "AA:BB:CC:00:11:22" }, CTX);

    assertEquals((await repo.listInterfaces(device.id)).length, 1);

    const entries = await audit.query(
      { entityType: "network_interface", entityId: iface.id },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assertEquals(entries.items[0].action, "create");
  });
});

Deno.test("addInterface rejects malformed MACs and unknown devices", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const device = await repo.create(validInput(), CTX);

    await assertRejects(
      () => repo.addInterface(device.id, { macAddress: "not-a-mac" }, CTX),
      TaxonomyViolationError,
    );
    await assertRejects(
      () =>
        repo.addInterface("ghost", { macAddress: "AA:BB:CC:00:11:22" }, {
          ...CTX,
        }),
      NotFoundError,
    );
  });
});

Deno.test("recordIpObservation appends history and refreshes the current IP", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    const device = await repo.create(validInput(), CTX);
    const iface = await repo.addInterface(
      device.id,
      { macAddress: "AA:BB:CC:00:11:22" },
      CTX,
    );

    // First observation opens the history.
    const first = await repo.recordIpObservation(
      iface.id,
      "10.0.0.5",
      "2026-07-01T00:00:00.000Z",
      CTX,
    );
    assertEquals(first.ipAddress, "10.0.0.5");
    assertEquals(first.firstSeen, "2026-07-01T00:00:00.000Z");
    assertEquals(first.lastSeen, "2026-07-01T00:00:00.000Z");

    // Re-observing the same current IP refreshes last_seen on the SAME row.
    const refreshed = await repo.recordIpObservation(
      iface.id,
      "10.0.0.5",
      "2026-07-02T00:00:00.000Z",
      CTX,
    );
    assertEquals(refreshed.id, first.id, "same IP must not append a row");
    assertEquals(refreshed.firstSeen, "2026-07-01T00:00:00.000Z");
    assertEquals(refreshed.lastSeen, "2026-07-02T00:00:00.000Z");

    // A different IP appends a new row; history is never rewritten.
    const changed = await repo.recordIpObservation(
      iface.id,
      "10.0.0.9",
      "2026-07-03T00:00:00.000Z",
      CTX,
    );
    assert(changed.id !== first.id, "changed IP must append a new row");

    const history = await repo.listIpHistory(iface.id);
    assertEquals(history.length, 2);
    assertEquals(history[0].ipAddress, "10.0.0.5");
    assertEquals(history[0].firstSeen, "2026-07-01T00:00:00.000Z");
    assertEquals(history[0].lastSeen, "2026-07-02T00:00:00.000Z");
    assertEquals(history[1].ipAddress, "10.0.0.9");
  });
});

Deno.test("recordIpObservation throws NotFoundError for an unknown interface", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);
    await assertRejects(
      () =>
        repo.recordIpObservation(
          "ghost",
          "10.0.0.1",
          "2026-07-01T00:00:00.000Z",
          CTX,
        ),
      NotFoundError,
    );
  });
});

Deno.test("list honors every DeviceFilter field and paginates with a total", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoDeviceRepository(db);

    await repo.create(
      validInput({
        hostname: "web-01",
        status: "authorized",
        environment: "physical",
        criticality: "high",
        department: "Engineering",
      }),
      CTX,
    );
    await repo.create(
      validInput({
        hostname: "db-01",
        status: "quarantined",
        environment: "virtual",
        criticality: "mission_critical",
        department: "Engineering",
      }),
      CTX,
    );
    await repo.create(
      validInput({
        hostname: "laptop-7",
        enterpriseAssetType: "end_user_device",
        endUserDeviceSubtype: "portable",
        status: "pending_review",
        environment: "physical",
        criticality: "low",
        department: "Sales",
      }),
      CTX,
    );
    await repo.create(
      validInput({
        hostname: "usb-drive-1",
        deviceClass: "removable_media",
        enterpriseAssetType: null,
        status: "unauthorized",
        criticality: "medium",
        department: "Sales",
      }),
      CTX,
    );

    assertEquals((await repo.list({}, PAGE)).total, 4);
    assertEquals((await repo.list({ status: "quarantined" }, PAGE)).total, 1);
    assertEquals(
      (await repo.list({ deviceClass: "removable_media" }, PAGE)).total,
      1,
    );
    assertEquals(
      (await repo.list({ enterpriseAssetType: "server" }, PAGE)).total,
      2,
    );
    assertEquals((await repo.list({ environment: "virtual" }, PAGE)).total, 1);
    assertEquals(
      (await repo.list({ criticality: "mission_critical" }, PAGE)).total,
      1,
    );
    assertEquals((await repo.list({ department: "Sales" }, PAGE)).total, 2);
    assertEquals(
      (await repo.list({ hostnameContains: "web" }, PAGE)).total,
      1,
    );
    assertEquals(
      (await repo.list(
        { department: "Engineering", status: "authorized" },
        PAGE,
      )).total,
      1,
    );

    // Pagination: stable order, correct total on every page.
    const page1 = await repo.list({}, { limit: 3, offset: 0 });
    const page2 = await repo.list({}, { limit: 3, offset: 3 });
    assertEquals(page1.items.length, 3);
    assertEquals(page2.items.length, 1);
    assertEquals(page1.total, 4);
    assertEquals(page2.total, 4);
    const ids = new Set([...page1.items, ...page2.items].map((d) => d.id));
    assertEquals(ids.size, 4, "pages must not overlap");
  });
});
