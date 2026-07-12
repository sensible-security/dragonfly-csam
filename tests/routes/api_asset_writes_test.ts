// Write-API handler tests (routes PRD §4.1/§4.2, Gate Q1): creates flow
// through the manual connector + reconciliation and report an outcome
// (created / auto_merged / queued); edits and status transitions hit the
// audited repository setters directly. Temp-DB container per test.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type Container, createContainer } from "@/db/container.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";
import { createDevice } from "@/routes/api/devices/index.ts";
import { patchDevice } from "@/routes/api/devices/[id].ts";
import { setDeviceStatus } from "@/routes/api/devices/[id]/status.ts";
import { createSoftware } from "@/routes/api/software/index.ts";
import { patchSoftware } from "@/routes/api/software/[id].ts";
import { setSoftwareAuthorization } from "@/routes/api/software/[id]/authorization.ts";
import { setSoftwareSupport } from "@/routes/api/software/[id]/support.ts";

const CTX: AuditContext = { actorType: "user", actorId: "system" };

async function withContainer(
  fn: (container: Container) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-writes-" });
  const container = await createContainer({ dbPath: join(dir, "test.db") });
  try {
    await fn(container);
  } finally {
    await container.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function deviceBody(overrides: Record<string, unknown> = {}) {
  return {
    matchKeys: { hostname: "new-01", domain: "corp.local" },
    fields: {
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname: "new-01",
      domain: "corp.local",
      owner: "IT Ops",
      department: "Engineering",
      criticality: "medium",
      businessImpact: "internal service",
    },
    ...overrides,
  };
}

Deno.test("POST /api/devices creates through the pipeline → 201 created", async () => {
  await withContainer(async (container) => {
    const res = await createDevice(container, deviceBody());
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.outcome, "created");
    assert(typeof body.entityId === "string");
    assert(typeof body.batchId === "string");

    const device = await container.repositories.devices.getById(body.entityId);
    assertEquals(device?.hostname, "new-01");
    assertEquals(device?.status, "pending_review");

    // The create carries provenance + audit through the pipeline.
    const provenance = await container.repositories.sourceRecords
      .getFieldProvenance("device", body.entityId);
    assert(provenance.length > 0);
  });
});

Deno.test("POST /api/devices auto-merges on a matching serial → 200 auto_merged", async () => {
  await withContainer(async (container) => {
    const existing = await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname: "web-01",
      hardwareSerial: "SER-123",
      owner: "IT Ops",
      department: "Engineering",
      criticality: "high",
      businessImpact: "storefront",
    }, CTX);

    const res = await createDevice(
      container,
      deviceBody({
        matchKeys: { hardwareSerial: "SER-123" },
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.outcome, "auto_merged");
    assertEquals(body.entityId, existing.id);
  });
});

Deno.test("POST /api/devices queues an ambiguous match → 200 queued + reviewItemId", async () => {
  await withContainer(async (container) => {
    // Two existing devices share the hostname+domain key → ambiguity.
    for (const serial of ["A-1", "A-2"]) {
      await container.repositories.devices.create({
        deviceClass: "enterprise_asset",
        enterpriseAssetType: "server",
        environment: "physical",
        hostname: "dup-01",
        domain: "corp.local",
        hardwareSerial: serial,
        owner: "IT Ops",
        department: "Engineering",
        criticality: "low",
        businessImpact: "test",
      }, CTX);
    }

    const res = await createDevice(
      container,
      deviceBody({ matchKeys: { hostname: "dup-01", domain: "corp.local" } }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.outcome, "queued");
    assert(typeof body.reviewItemId === "string");

    const item = await container.repositories.reviewQueue.getById(
      body.reviewItemId,
    );
    assertEquals(item?.status, "pending");
  });
});

Deno.test("POST /api/devices rejects an invalid observation with 400 + issues", async () => {
  await withContainer(async (container) => {
    const res = await createDevice(container, {
      matchKeys: {},
      fields: { deviceClass: "starship" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "validation_error");
    assert(Array.isArray(body.error.details));
  });
});

Deno.test("PATCH /api/devices/[id] updates mutable fields; status not patchable", async () => {
  await withContainer(async (container) => {
    const device = await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname: "web-01",
      owner: "IT Ops",
      department: "Engineering",
      criticality: "low",
      businessImpact: "test",
    }, CTX);

    const ok = await patchDevice(container.repositories, device.id, {
      department: "Platform",
    });
    assertEquals(ok.status, 200);
    assertEquals((await ok.json()).department, "Platform");

    const statusAttempt = await patchDevice(
      container.repositories,
      device.id,
      { status: "quarantined" },
    );
    assertEquals(statusAttempt.status, 400);

    const missing = await patchDevice(
      container.repositories,
      crypto.randomUUID(),
      { department: "X" },
    );
    assertEquals(missing.status, 404);
  });
});

Deno.test("POST /api/devices/[id]/status transitions and audits (Safeguard 1.2)", async () => {
  await withContainer(async (container) => {
    const device = await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname: "web-01",
      status: "authorized",
      owner: "IT Ops",
      department: "Engineering",
      criticality: "low",
      businessImpact: "test",
    }, CTX);

    const res = await setDeviceStatus(container.repositories, device.id, {
      status: "quarantined",
    }, CTX);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "quarantined");

    const audit = await container.repositories.auditLog.query({
      entityType: "device",
      entityId: device.id,
      action: "status_change",
    }, { limit: 10, offset: 0 });
    assertEquals(audit.total, 1);

    const bad = await setDeviceStatus(container.repositories, device.id, {
      status: "bogus",
    }, CTX);
    assertEquals(bad.status, 400);
  });
});

Deno.test("POST /api/software creates via pipeline; identity match auto-merges", async () => {
  await withContainer(async (container) => {
    const res = await createSoftware(container, {
      identity: { title: "Nginx", publisher: "F5", version: "1.25" },
      fields: {
        softwareType: "application",
        businessPurpose: "web serving",
        criticality: "high",
        businessImpact: "edge tier",
      },
    });
    assertEquals(res.status, 201);
    const created = await res.json();
    assertEquals(created.outcome, "created");

    // Same identity again → merged into the same catalog row.
    const again = await createSoftware(container, {
      identity: { title: "Nginx", publisher: "F5", version: "1.25" },
      fields: { businessPurpose: "web serving" },
    });
    assertEquals(again.status, 200);
    const merged = await again.json();
    assertEquals(merged.outcome, "auto_merged");
    assertEquals(merged.entityId, created.entityId);
  });
});

Deno.test("software authorization/support setters enforce taxonomy rules", async () => {
  await withContainer(async (container) => {
    const software = await container.repositories.software.create({
      title: "Tool",
      publisher: "Corp",
      version: "1.0",
      softwareType: "application",
      businessPurpose: "test",
      criticality: "low",
      businessImpact: "test",
    }, CTX);

    // exception_documented without an active exception → 422 (Safeguard 2.3).
    const noException = await setSoftwareAuthorization(
      container.repositories,
      software.id,
      { status: "exception_documented" },
      CTX,
    );
    assertEquals(noException.status, 422);

    const authorized = await setSoftwareAuthorization(
      container.repositories,
      software.id,
      { status: "authorized" },
      CTX,
    );
    assertEquals(authorized.status, 200);
    assertEquals((await authorized.json()).authorizationStatus, "authorized");

    const support = await setSoftwareSupport(
      container.repositories,
      software.id,
      { status: "eol_flagged" },
      CTX,
    );
    assertEquals(support.status, 200);
    assertEquals((await support.json()).supportStatus, "eol_flagged");

    const patched = await patchSoftware(container.repositories, software.id, {
      licenseCount: 25,
    });
    assertEquals(patched.status, 200);
    assertEquals((await patched.json()).licenseCount, 25);
  });
});
