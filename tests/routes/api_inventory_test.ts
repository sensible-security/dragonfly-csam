// Read-API handler tests (routes PRD §4.1–§4.3, Prompt 4.2 slice): list
// endpoints with pagination + taxonomy filtering + structured 400s, and the
// composed detail DTOs (interfaces/IP history, installations, provenance,
// staging records). Handlers are exported functions called directly over a
// temp-DB container — no Fresh boot (same pattern as health_test.ts).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type Container, createContainer } from "@/db/container.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";
import { listDevices } from "@/routes/api/devices/index.ts";
import { getDevice } from "@/routes/api/devices/[id].ts";
import { listSoftware } from "@/routes/api/software/index.ts";
import { getSoftware } from "@/routes/api/software/[id].ts";

const CTX: AuditContext = { actorType: "user", actorId: "system" };

function search(qs: string): URLSearchParams {
  return new URL(`http://localhost/x?${qs}`).searchParams;
}

async function withContainer(
  fn: (container: Container) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-api-" });
  const container = await createContainer({ dbPath: join(dir, "test.db") });
  try {
    await fn(container);
  } finally {
    await container.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function seedDevice(
  container: Container,
  overrides: Partial<
    Parameters<typeof container.repositories.devices.create>[0]
  > = {},
) {
  return await container.repositories.devices.create({
    deviceClass: "enterprise_asset",
    enterpriseAssetType: "server",
    environment: "physical",
    status: "authorized",
    hostname: "web-01",
    owner: "IT Ops",
    department: "Engineering",
    criticality: "high",
    businessImpact: "runs the storefront",
    ...overrides,
  }, CTX);
}

async function seedSoftware(
  container: Container,
  overrides: Partial<
    Parameters<typeof container.repositories.software.create>[0]
  > = {},
) {
  return await container.repositories.software.create({
    title: "Fixture Server",
    publisher: "Fixture Corp",
    version: "2.1.0",
    softwareType: "application",
    businessPurpose: "test fixture",
    criticality: "medium",
    businessImpact: "internal tooling",
    ...overrides,
  }, CTX);
}

Deno.test("GET /api/devices returns a Page with defaults", async () => {
  await withContainer(async (container) => {
    await seedDevice(container);
    await seedDevice(container, { hostname: "db-01", status: "quarantined" });

    const res = await listDevices(container.repositories, search(""));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.total, 2);
    assertEquals(body.limit, 50);
    assertEquals(body.offset, 0);
    assertEquals(body.items.length, 2);
  });
});

Deno.test("GET /api/devices filters by status and hostname substring", async () => {
  await withContainer(async (container) => {
    await seedDevice(container);
    const quarantined = await seedDevice(container, {
      hostname: "db-01",
      status: "quarantined",
    });

    const byStatus = await (await listDevices(
      container.repositories,
      search("status=quarantined"),
    )).json();
    assertEquals(byStatus.total, 1);
    assertEquals(byStatus.items[0].id, quarantined.id);

    const byHostname = await (await listDevices(
      container.repositories,
      search("hostname=db"),
    )).json();
    assertEquals(byHostname.total, 1);
    assertEquals(byHostname.items[0].hostname, "db-01");
  });
});

Deno.test("GET /api/devices rejects out-of-enum filters with 400 validation_error", async () => {
  await withContainer(async (container) => {
    const res = await listDevices(
      container.repositories,
      search("status=bogus"),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "validation_error");
    assertEquals(body.error.details[0].field, "status");
  });
});

Deno.test("GET /api/devices clamps pagination", async () => {
  await withContainer(async (container) => {
    await seedDevice(container);
    const body = await (await listDevices(
      container.repositories,
      search("limit=9999"),
    )).json();
    assertEquals(body.limit, 200);
  });
});

Deno.test("GET /api/devices/[id] returns 404 not_found for unknown ids", async () => {
  await withContainer(async (container) => {
    const res = await getDevice(container.repositories, crypto.randomUUID());
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "not_found");
  });
});

Deno.test("GET /api/devices/[id] composes the full detail DTO", async () => {
  await withContainer(async (container) => {
    const { repositories } = container;
    const device = await seedDevice(container);

    // Interface + appended IP history (Safeguard 1.1).
    const nic = await repositories.devices.addInterface(device.id, {
      macAddress: "aa:bb:cc:00:11:22",
    }, CTX);
    await repositories.devices.recordIpObservation(
      nic.id,
      "10.0.0.5",
      "2026-07-01T00:00:00.000Z",
      CTX,
    );
    await repositories.devices.recordIpObservation(
      nic.id,
      "10.0.0.9",
      "2026-07-02T00:00:00.000Z",
      CTX,
    );

    // Installed software with resolved catalog entry.
    const software = await seedSoftware(container);
    await repositories.software.recordInstallation({
      deviceId: device.id,
      softwareId: software.id,
    }, CTX);

    // Field provenance + the staging record that fed the asset.
    const source = await repositories.sourceRecords.registerSource(
      { sourceType: "scanner_json", name: "nmap-dc" },
      CTX,
    );
    await repositories.sourceRecords.setFieldProvenance(
      "device",
      device.id,
      "hostname",
      source.id,
      "2026-07-01T00:00:00.000Z",
    );
    const record = await repositories.sourceRecords.upsertObservation({
      sourceId: source.id,
      externalId: "host-42",
      entityKind: "device",
      rawPayload: "{}",
      normalizedPayload: "{}",
      observedAt: "2026-07-01T00:00:00.000Z",
    }, CTX);
    await repositories.sourceRecords.setReconciliationOutcome(
      record.id,
      "created",
      "device",
      device.id,
    );

    const res = await getDevice(container.repositories, device.id);
    assertEquals(res.status, 200);
    const body = await res.json();

    assertEquals(body.device.id, device.id);
    assertEquals(body.interfaces.length, 1);
    assertEquals(body.interfaces[0].interface.macAddress, "AA:BB:CC:00:11:22");
    assertEquals(body.interfaces[0].ipHistory.length, 2);
    assertEquals(body.installations.length, 1);
    assertEquals(body.installations[0].software.title, software.title);
    assertEquals(body.provenance.length, 1);
    assertEquals(body.provenance[0].field.fieldName, "hostname");
    assertEquals(body.provenance[0].sourceName, "nmap-dc");
    assertEquals(body.sourceRecords.length, 1);
    assertEquals(body.sourceRecords[0].record.id, record.id);
    assertEquals(body.sourceRecords[0].sourceName, "nmap-dc");
  });
});

Deno.test("GET /api/software filters by support status and eolBefore", async () => {
  await withContainer(async (container) => {
    await seedSoftware(container);
    const eol = await seedSoftware(container, {
      title: "Legacy Suite",
      supportStatus: "eol_flagged",
      eolDate: "2026-01-31",
    });

    const bySupport = await (await listSoftware(
      container.repositories,
      search("supportStatus=eol_flagged"),
    )).json();
    assertEquals(bySupport.total, 1);
    assertEquals(bySupport.items[0].id, eol.id);

    const byEol = await (await listSoftware(
      container.repositories,
      search("eolBefore=2026-06-01"),
    )).json();
    assertEquals(byEol.total, 1);
    assertEquals(byEol.items[0].id, eol.id);

    const invalid = await listSoftware(
      container.repositories,
      search("supportStatus=bogus"),
    );
    assertEquals(invalid.status, 400);
  });
});

Deno.test("GET /api/software/[id] composes installations, exceptions, provenance", async () => {
  await withContainer(async (container) => {
    const { repositories } = container;
    const software = await seedSoftware(container);
    const device = await seedDevice(container);

    await repositories.software.recordInstallation({
      deviceId: device.id,
      softwareId: software.id,
    }, CTX);
    await repositories.software.addException({
      softwareId: software.id,
      justification: "vendor contract runs through 2027",
      approvedBy: "ciso",
      reviewBy: "2027-01-01",
    }, CTX);

    const res = await getSoftware(container.repositories, software.id);
    assertEquals(res.status, 200);
    const body = await res.json();

    assertEquals(body.software.id, software.id);
    assertEquals(body.installations.length, 1);
    assertEquals(body.installations[0].device.hostname, "web-01");
    assertEquals(body.exceptions.length, 1);
    assert(Array.isArray(body.provenance));
    assert(Array.isArray(body.sourceRecords));

    const missing = await getSoftware(
      container.repositories,
      crypto.randomUUID(),
    );
    assertEquals(missing.status, 404);
  });
});
