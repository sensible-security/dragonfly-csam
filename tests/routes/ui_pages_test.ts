// Loader tests for the folded Phase-4 pages (routes PRD §5.1, §5.6–§5.8):
// dashboard KPI counts, review-queue listing, ingestion batches, audit viewer.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { HttpError } from "fresh";
import { type Container, createContainer } from "@/db/container.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";
import { loadDashboard } from "@/routes/index.tsx";
import { loadReviewQueuePage } from "@/routes/review-queue.tsx";
import { loadIngestionPage } from "@/routes/ingestion.tsx";
import { loadAuditLogPage } from "@/routes/audit-log.tsx";
import { importCsv } from "@/routes/api/import/csv.ts";

const CTX: AuditContext = { actorType: "user", actorId: "analyst-1" };

function search(qs: string): URLSearchParams {
  return new URL(`http://localhost/x?${qs}`).searchParams;
}

async function withContainer(
  fn: (container: Container) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-ui-pages-" });
  const container = await createContainer({ dbPath: join(dir, "test.db") });
  try {
    await fn(container);
  } finally {
    await container.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadDashboard aggregates KPI counts from filtered totals", async () => {
  await withContainer(async (container) => {
    await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      status: "quarantined",
      hostname: "kpi-01",
      owner: "IT",
      department: "Eng",
      criticality: "high",
      businessImpact: "test",
    }, CTX);
    await container.repositories.software.create({
      title: "Old Tool",
      publisher: "Corp",
      version: "1.0",
      softwareType: "application",
      supportStatus: "eol_flagged",
      businessPurpose: "legacy",
      criticality: "low",
      businessImpact: "test",
    }, CTX);

    const data = await loadDashboard(
      container.repositories,
      container.services,
    );
    assertEquals(data.totalDevices, 1);
    assertEquals(data.totalSoftware, 1);
    assertEquals(data.devicesByStatus.quarantined, 1);
    assertEquals(data.devicesByCriticality.high, 1);
    assertEquals(data.unauthorizedSoftware, 1); // create default
    assertEquals(data.eolOrUnsupportedSoftware, 1);
    assertEquals(data.pendingReview, 0);
  });
});

Deno.test("loadReviewQueuePage lists via ReviewService; bad query is 400", async () => {
  await withContainer(async (container) => {
    const data = await loadReviewQueuePage(container.services, search(""));
    assertEquals(data.result.total, 0);

    const err = await assertRejects(
      () => loadReviewQueuePage(container.services, search("reason=nope")),
      HttpError,
    );
    assertEquals(err.status, 400);
  });
});

Deno.test("loadIngestionPage lists recent batches with source names", async () => {
  await withContainer(async (container) => {
    const csvText = [
      "Host,Class,Type,Env,Owner,Dept,Crit,Impact",
      "ing-01,enterprise_asset,server,physical,IT,Eng,low,test",
    ].join("\n");
    await importCsv(container, {
      csvText,
      columnMapping: {
        Host: "hostname",
        Class: "deviceClass",
        Type: "enterpriseAssetType",
        Env: "environment",
        Owner: "owner",
        Dept: "department",
        Crit: "criticality",
        Impact: "businessImpact",
      },
      sourceName: "quarterly-csv",
    }, CTX);

    const data = await loadIngestionPage(container.repositories);
    assertEquals(data.batches.length, 1);
    assertEquals(data.batches[0].sourceName, "quarterly-csv");
    assertEquals(data.batches[0].batch.status, "completed");
  });
});

Deno.test("loadAuditLogPage filters audit entries; bad action is 400", async () => {
  await withContainer(async (container) => {
    const device = await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname: "aud-01",
      owner: "IT",
      department: "Eng",
      criticality: "low",
      businessImpact: "test",
    }, CTX);

    const data = await loadAuditLogPage(
      container.repositories,
      search(`entityId=${device.id}`),
    );
    assertEquals(data.result.total, 1);
    assertEquals(data.result.items[0].action, "create");

    const err = await assertRejects(
      () => loadAuditLogPage(container.repositories, search("action=nope")),
      HttpError,
    );
    assertEquals(err.status, 400);
    assert(err instanceof HttpError);
  });
});
