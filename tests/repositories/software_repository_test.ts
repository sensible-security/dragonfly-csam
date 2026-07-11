// B3 contract tests: TursoSoftwareRepository (Safeguards 2.1, 2.2, 2.3;
// ID.AM-02, -05). Covers catalog CRUD with audit entries, the documented-
// exception invariant, and the installation lifecycle on device_software.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import { TursoDeviceRepository } from "@/db/repositories/turso/device_repository.ts";
import { TursoSoftwareRepository } from "@/db/repositories/turso/software_repository.ts";
import {
  type AuditContext,
  type CreateSoftware,
  type Device,
  DuplicateAssetError,
  MissingCriticalityError,
  NotFoundError,
  TaxonomyViolationError,
} from "@/db/repositories/interfaces/mod.ts";
import type { DatabaseConnection } from "@/db/repositories/turso/connection.ts";
import { withTempDb } from "./helpers.ts";

const CTX: AuditContext = {
  actorType: "user",
  actorId: "analyst-1",
  sourceAddress: "203.0.113.7",
};

const PAGE = { limit: 50, offset: 0 };

function validInput(overrides: Partial<CreateSoftware> = {}): CreateSoftware {
  return {
    title: "PostgreSQL",
    publisher: "PostgreSQL Global Development Group",
    version: "16.3",
    softwareType: "application",
    businessPurpose: "primary datastore",
    criticality: "high",
    businessImpact: "all persistence",
    ...overrides,
  };
}

async function fixtureDevice(db: DatabaseConnection): Promise<Device> {
  return await new TursoDeviceRepository(db).create({
    deviceClass: "enterprise_asset",
    enterpriseAssetType: "server",
    environment: "physical",
    status: "authorized",
    hostname: "db-01",
    owner: "IT Ops",
    department: "Engineering",
    criticality: "high",
    businessImpact: "runs the datastore",
  }, CTX);
}

Deno.test("create persists the catalog entry, defaults, and a create audit entry", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);
    const audit = new TursoAuditLogRepository(db);

    const software = await repo.create(
      validInput({
        componentType: "service",
        eolDate: "2029-11-08",
        url: "https://www.postgresql.org",
        deploymentMechanism: "ansible",
        licenseCount: 25,
        cpe: "cpe:2.3:a:postgresql:postgresql:16.3:*:*:*:*:*:*:*",
      }),
      CTX,
    );

    assert(software.id.length > 0);
    assertEquals(software.title, "PostgreSQL");
    assertEquals(software.version, "16.3");
    assertEquals(software.softwareType, "application");
    assertEquals(software.componentType, "service");
    assertEquals(software.authorizationStatus, "unauthorized", "default");
    assertEquals(software.supportStatus, "supported", "default");
    assertEquals(software.eolDate, "2029-11-08");
    assertEquals(software.licenseCount, 25);
    assertEquals(
      software.cpe,
      "cpe:2.3:a:postgresql:postgresql:16.3:*:*:*:*:*:*:*",
    );
    assertEquals(await repo.getById(software.id), software);

    const entries = await audit.query(
      { entityType: "software", entityId: software.id, action: "create" },
      PAGE,
    );
    assertEquals(entries.total, 1);
  });
});

Deno.test("create rejects a duplicate (title, publisher, version)", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);
    await repo.create(validInput(), CTX);
    await assertRejects(
      () => repo.create(validInput(), CTX),
      DuplicateAssetError,
    );
    // A different version of the same title is a distinct catalog entry.
    await repo.create(validInput({ version: "17.0" }), CTX);
    assertEquals((await repo.list({}, PAGE)).total, 2);
  });
});

Deno.test("create rejects missing criticality/business_impact and firmware components", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);

    await assertRejects(
      () =>
        repo.create(
          { ...validInput(), criticality: "" } as unknown as CreateSoftware,
          CTX,
        ),
      MissingCriticalityError,
    );
    await assertRejects(
      () =>
        repo.create(
          {
            ...validInput(),
            businessImpact: undefined,
          } as unknown as CreateSoftware,
          CTX,
        ),
      MissingCriticalityError,
    );
    // Hierarchy: component types are children of application/OS, never
    // firmware (AGENTS.md §5).
    await assertRejects(
      () =>
        repo.create(
          validInput({ softwareType: "firmware", componentType: "library" }),
          CTX,
        ),
      TaxonomyViolationError,
    );
    assertEquals((await repo.list({}, PAGE)).total, 0);
  });
});

Deno.test("update patches fields, audits a diff, and re-validates hierarchy", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const software = await repo.create(validInput(), CTX);

    const updated = await repo.update(
      software.id,
      { businessPurpose: "reporting datastore", licenseCount: 10 },
      CTX,
    );
    assertEquals(updated.businessPurpose, "reporting datastore");
    assertEquals(updated.licenseCount, 10);
    assertEquals(updated.title, "PostgreSQL", "untouched field kept");

    const entries = await audit.query(
      { entityType: "software", entityId: software.id, action: "update" },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assertEquals(
      JSON.parse(entries.items[0].beforeJson ?? "{}").businessPurpose,
      "primary datastore",
    );

    const firmware = await repo.create(
      validInput({ title: "BIOS", softwareType: "firmware", version: "1.2" }),
      CTX,
    );
    await assertRejects(
      () => repo.update(firmware.id, { componentType: "api" }, CTX),
      TaxonomyViolationError,
    );
    await assertRejects(
      () => repo.update("ghost", { title: "x" }, CTX),
      NotFoundError,
    );
  });
});

Deno.test("setSupportStatus persists and writes a status_change audit entry", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const software = await repo.create(validInput(), CTX);

    const flagged = await repo.setSupportStatus(
      software.id,
      "eol_flagged",
      CTX,
    );
    assertEquals(flagged.supportStatus, "eol_flagged");
    assertEquals(
      (await repo.getById(software.id))?.supportStatus,
      "eol_flagged",
    );

    const entries = await audit.query(
      {
        entityType: "software",
        entityId: software.id,
        action: "status_change",
      },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assertEquals(
      JSON.parse(entries.items[0].beforeJson ?? "{}").supportStatus,
      "supported",
    );
    assertEquals(
      JSON.parse(entries.items[0].afterJson ?? "{}").supportStatus,
      "eol_flagged",
    );
  });
});

Deno.test("setAuthorizationStatus is atomic: audit failure rolls the change back", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);
    const software = await repo.create(validInput(), CTX);
    const bogusCtx = {
      actorType: "intruder",
      actorId: "x",
    } as unknown as AuditContext;

    await assertRejects(() =>
      repo.setAuthorizationStatus(software.id, "authorized", bogusCtx)
    );
    assertEquals(
      (await repo.getById(software.id))?.authorizationStatus,
      "unauthorized",
      "failed audit write must roll back the status change",
    );
  });
});

Deno.test("exception_documented requires an active exception; revoke deactivates it", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const software = await repo.create(validInput(), CTX);

    // No active exception yet → rejected (PRD §2.3-exceptions invariant).
    await assertRejects(
      () =>
        repo.setAuthorizationStatus(software.id, "exception_documented", CTX),
      TaxonomyViolationError,
    );

    const exception = await repo.addException({
      softwareId: software.id,
      justification: "legacy line-of-business dependency",
      approvedBy: "ciso@example.com",
      reviewBy: "2027-01-01",
    }, CTX);
    assertEquals(exception.softwareId, software.id);
    assertEquals(exception.revokedAt, null);

    const documented = await repo.setAuthorizationStatus(
      software.id,
      "exception_documented",
      CTX,
    );
    assertEquals(documented.authorizationStatus, "exception_documented");

    assertEquals((await repo.listActiveExceptions(software.id)).length, 1);
    await repo.revokeException(exception.id, CTX);
    assertEquals(
      (await repo.listActiveExceptions(software.id)).length,
      0,
      "revoked exception must not be listed as active",
    );

    // Exception lifecycle is audited.
    const created = await audit.query(
      { entityType: "exception", entityId: exception.id },
      PAGE,
    );
    assertEquals(created.total, 2, "create + revoke audit entries");

    await assertRejects(
      () => repo.revokeException("ghost", CTX),
      NotFoundError,
    );
  });
});

Deno.test("installation lifecycle: record, uninstall, reinstall on one row", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);
    const device = await fixtureDevice(db);
    const software = await repo.create(validInput(), CTX);

    const install = await repo.recordInstallation({
      deviceId: device.id,
      softwareId: software.id,
      installDate: "2026-06-01",
    }, CTX);
    assertEquals(install.deviceId, device.id);
    assertEquals(install.softwareId, software.id);
    assertEquals(install.installDate, "2026-06-01");
    assertEquals(install.uninstalledAt, null);

    await repo.markUninstalled(
      device.id,
      software.id,
      "2026-07-01T00:00:00.000Z",
      CTX,
    );
    const afterUninstall = await repo.listInstallationsForDevice(device.id);
    assertEquals(afterUninstall.length, 1);
    assertEquals(afterUninstall[0].uninstalledAt, "2026-07-01T00:00:00.000Z");

    // Reinstall reactivates the SAME row (UNIQUE device+software).
    const reinstall = await repo.recordInstallation({
      deviceId: device.id,
      softwareId: software.id,
      installDate: "2026-07-05",
    }, CTX);
    assertEquals(reinstall.id, install.id, "one row per (device, software)");
    assertEquals(reinstall.uninstalledAt, null);
    assertEquals(reinstall.installDate, "2026-07-05");

    assertEquals((await repo.listInstallationsForDevice(device.id)).length, 1);
    assertEquals(
      (await repo.listInstallationsForSoftware(software.id)).length,
      1,
    );

    await assertRejects(
      () =>
        repo.recordInstallation(
          { deviceId: "ghost", softwareId: software.id },
          CTX,
        ),
      NotFoundError,
    );
    await assertRejects(
      () =>
        repo.markUninstalled(device.id, "ghost", "2026-07-06T00:00:00Z", CTX),
      NotFoundError,
    );
  });
});

Deno.test("list honors every SoftwareFilter field including eolBefore", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoSoftwareRepository(db);

    await repo.create(
      validInput({
        title: "PostgreSQL",
        authorizationStatus: "authorized",
        eolDate: "2029-11-08",
        criticality: "high",
      }),
      CTX,
    );
    await repo.create(
      validInput({
        title: "Windows Server",
        publisher: "Microsoft",
        version: "2012 R2",
        softwareType: "operating_system",
        supportStatus: "unsupported",
        eolDate: "2023-10-10",
        criticality: "mission_critical",
      }),
      CTX,
    );
    await repo.create(
      validInput({
        title: "Router Firmware",
        publisher: "Cisco",
        version: "9.1",
        softwareType: "firmware",
        criticality: "low",
      }),
      CTX,
    );

    assertEquals((await repo.list({}, PAGE)).total, 3);
    assertEquals(
      (await repo.list({ softwareType: "operating_system" }, PAGE)).total,
      1,
    );
    assertEquals(
      (await repo.list({ authorizationStatus: "authorized" }, PAGE)).total,
      1,
    );
    assertEquals(
      (await repo.list({ supportStatus: "unsupported" }, PAGE)).total,
      1,
    );
    assertEquals(
      (await repo.list({ criticality: "mission_critical" }, PAGE)).total,
      1,
    );
    assertEquals(
      (await repo.list({ eolBefore: "2026-01-01" }, PAGE)).total,
      1,
      "only software whose EOL date precedes the cutoff",
    );
    assertEquals(
      (await repo.list({ titleContains: "Server" }, PAGE)).total,
      1,
    );

    const page1 = await repo.list({}, { limit: 2, offset: 0 });
    const page2 = await repo.list({}, { limit: 2, offset: 2 });
    assertEquals(page1.items.length, 2);
    assertEquals(page2.items.length, 1);
    assertEquals(page1.total, 3);
  });
});
