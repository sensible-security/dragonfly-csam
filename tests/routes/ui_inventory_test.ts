// UI route data-loader tests (routes PRD §9: "handlers return 200 with
// expected data props"). The pages export their loaders (same pattern as the
// API handlers); rendering is server-side Preact over these props.
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { HttpError } from "fresh";
import { type Container, createContainer } from "@/db/container.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";
import { loadDevicesPage } from "@/routes/devices/index.tsx";
import { loadDeviceDetailPage } from "@/routes/devices/[id].tsx";
import { loadSoftwarePage } from "@/routes/software/index.tsx";
import { loadSoftwareDetailPage } from "@/routes/software/[id].tsx";

const CTX: AuditContext = { actorType: "user", actorId: "system" };

function search(qs: string): URLSearchParams {
  return new URL(`http://localhost/x?${qs}`).searchParams;
}

async function withContainer(
  fn: (container: Container) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-ui-" });
  const container = await createContainer({ dbPath: join(dir, "test.db") });
  try {
    await fn(container);
  } finally {
    await container.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadDevicesPage returns the filtered page for the query", async () => {
  await withContainer(async (container) => {
    await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      status: "authorized",
      hostname: "web-01",
      owner: "IT Ops",
      department: "Engineering",
      criticality: "high",
      businessImpact: "storefront",
    }, CTX);
    await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "end_user_device",
      endUserDeviceSubtype: "portable",
      environment: "physical",
      status: "quarantined",
      hostname: "laptop-07",
      owner: "Alice",
      department: "Finance",
      criticality: "medium",
      businessImpact: "user endpoint",
    }, CTX);

    const all = await loadDevicesPage(container.repositories, search(""));
    assertEquals(all.result.total, 2);

    const filtered = await loadDevicesPage(
      container.repositories,
      search("status=quarantined"),
    );
    assertEquals(filtered.result.total, 1);
    assertEquals(filtered.result.items[0].hostname, "laptop-07");
  });
});

Deno.test("loadDevicesPage throws HttpError(400) on an invalid query", async () => {
  await withContainer(async (container) => {
    const err = await assertRejects(
      () => loadDevicesPage(container.repositories, search("status=bogus")),
      HttpError,
    );
    assertEquals(err.status, 400);
  });
});

Deno.test("loadDeviceDetailPage returns the detail DTO or 404s", async () => {
  await withContainer(async (container) => {
    const device = await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "virtual",
      hostname: "app-01",
      owner: "IT Ops",
      department: "Engineering",
      criticality: "low",
      businessImpact: "internal",
    }, CTX);

    const detail = await loadDeviceDetailPage(
      container.repositories,
      device.id,
    );
    assertEquals(detail.detail.device.id, device.id);

    const err = await assertRejects(
      () => loadDeviceDetailPage(container.repositories, crypto.randomUUID()),
      HttpError,
    );
    assertEquals(err.status, 404);
  });
});

Deno.test("loadSoftwarePage filters and loadSoftwareDetailPage 404s", async () => {
  await withContainer(async (container) => {
    const software = await container.repositories.software.create({
      title: "Legacy Suite",
      publisher: "Old Corp",
      version: "9.0",
      softwareType: "application",
      supportStatus: "eol_flagged",
      eolDate: "2026-01-31",
      businessPurpose: "legacy workflow",
      criticality: "high",
      businessImpact: "finance closes",
    }, CTX);

    const filtered = await loadSoftwarePage(
      container.repositories,
      search("supportStatus=eol_flagged"),
    );
    assertEquals(filtered.result.total, 1);
    assertEquals(filtered.result.items[0].id, software.id);

    const detail = await loadSoftwareDetailPage(
      container.repositories,
      software.id,
    );
    assertEquals(detail.detail.software.title, "Legacy Suite");

    const err = await assertRejects(
      () => loadSoftwareDetailPage(container.repositories, crypto.randomUUID()),
      HttpError,
    );
    assertEquals(err.status, 404);
  });
});
