// Handler tests for the read-only audit-log + source-record APIs, the CSV
// import route, and the batch error-report download (routes PRD §4.3, §4.5,
// §4.6). The error report is text/csv with formula-injection guarding —
// untrusted cells must never execute in a spreadsheet.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type Container, createContainer } from "@/db/container.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";
import { listAuditLog } from "@/routes/api/audit-log.ts";
import { listSourceRecords } from "@/routes/api/source-records/index.ts";
import { getSourceRecord } from "@/routes/api/source-records/[id].ts";
import { importCsv } from "@/routes/api/import/csv.ts";
import { downloadBatchErrors } from "@/routes/api/ingestion-batches/[id]/errors.ts";

const CTX: AuditContext = { actorType: "user", actorId: "analyst-1" };

function search(qs: string): URLSearchParams {
  return new URL(`http://localhost/x?${qs}`).searchParams;
}

async function withContainer(
  fn: (container: Container) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-audit-api-" });
  const container = await createContainer({ dbPath: join(dir, "test.db") });
  try {
    await fn(container);
  } finally {
    await container.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const CSV_MAPPING = {
  Host: "hostname",
  Serial: "hardwareSerial",
  Class: "deviceClass",
  Type: "enterpriseAssetType",
  Env: "environment",
  Owner: "owner",
  Dept: "department",
  Crit: "criticality",
  Impact: "businessImpact",
};

Deno.test("GET /api/audit-log filters by entityType/action; bad action is 400", async () => {
  await withContainer(async (container) => {
    const device = await container.repositories.devices.create({
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      hostname: "audit-01",
      owner: "IT",
      department: "Eng",
      criticality: "low",
      businessImpact: "test",
    }, CTX);
    await container.repositories.devices.setStatus(
      device.id,
      "quarantined",
      CTX,
    );

    const all = await (await listAuditLog(
      container.repositories,
      search("entityType=device"),
    )).json();
    assertEquals(all.total, 2); // create + status_change

    const statusOnly = await (await listAuditLog(
      container.repositories,
      search("entityType=device&action=status_change"),
    )).json();
    assertEquals(statusOnly.total, 1);
    assertEquals(statusOnly.items[0].actorId, "analyst-1");

    const bad = await listAuditLog(
      container.repositories,
      search("action=explode"),
    );
    assertEquals(bad.status, 400);
  });
});

Deno.test("GET /api/source-records requires a source; lists staged records", async () => {
  await withContainer(async (container) => {
    const { sourceRecords } = container.repositories;
    const source = await sourceRecords.registerSource(
      { sourceType: "scanner_json", name: "nmap-dc" },
      CTX,
    );
    await sourceRecords.upsertObservation({
      sourceId: source.id,
      externalId: "sr-1",
      entityKind: "device",
      rawPayload: "{}",
      normalizedPayload: "{}",
      observedAt: "2026-07-01T00:00:00.000Z",
    }, CTX);

    const missing = await listSourceRecords(
      container.repositories,
      search(""),
    );
    assertEquals(missing.status, 400);

    const byId = await (await listSourceRecords(
      container.repositories,
      search(`sourceId=${source.id}`),
    )).json();
    assertEquals(byId.total, 1);
    assertEquals(byId.items[0].reconciliationStatus, "pending");

    const byName = await (await listSourceRecords(
      container.repositories,
      search("sourceName=nmap-dc"),
    )).json();
    assertEquals(byName.total, 1);

    const unknown = await listSourceRecords(
      container.repositories,
      search("sourceName=nope"),
    );
    assertEquals(unknown.status, 404);
  });
});

Deno.test("GET /api/source-records/[id] returns the record or 404", async () => {
  await withContainer(async (container) => {
    const { sourceRecords } = container.repositories;
    const source = await sourceRecords.registerSource(
      { sourceType: "manual", name: "manual" },
      CTX,
    );
    const record = await sourceRecords.upsertObservation({
      sourceId: source.id,
      externalId: "sr-2",
      entityKind: "device",
      rawPayload: '{"note":"verbatim"}',
      normalizedPayload: "{}",
      observedAt: "2026-07-01T00:00:00.000Z",
    }, CTX);

    const res = await getSourceRecord(container.repositories, record.id);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.record.id, record.id);
    assertEquals(body.sourceName, "manual");

    const missing = await getSourceRecord(
      container.repositories,
      crypto.randomUUID(),
    );
    assertEquals(missing.status, 404);
  });
});

Deno.test("POST /api/import/csv ingests and reports quarantined rows", async () => {
  await withContainer(async (container) => {
    const csvText = [
      "Host,Serial,Class,Type,Env,Owner,Dept,Crit,Impact",
      "imp01,S-1,enterprise_asset,server,physical,IT,Eng,high,prod",
      "imp02,S-2,enterprise_asset,server,physical,IT,Eng,ludicrous,bad",
    ].join("\n");

    const res = await importCsv(container, {
      csvText,
      columnMapping: CSV_MAPPING,
      sourceName: "quarterly-csv",
    }, CTX);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.received, 2);
    assertEquals(body.staged, 1);
    assertEquals(body.quarantined.length, 1);
    assert(typeof body.batchId === "string");

    const invalid = await importCsv(container, { csvText }, CTX);
    assertEquals(invalid.status, 400);
  });
});

Deno.test("GET /api/ingestion-batches/[id]/errors downloads a guarded CSV report", async () => {
  await withContainer(async (container) => {
    const csvText = [
      "Host,Serial,Class,Type,Env,Owner,Dept,Crit,Impact",
      '=HYPERLINK("http://evil"),S-9,enterprise_asset,server,physical,IT,Eng,ludicrous,bad',
    ].join("\n");
    const imported = await (await importCsv(container, {
      csvText,
      columnMapping: CSV_MAPPING,
      sourceName: "quarterly-csv",
    }, CTX)).json();

    const res = await downloadBatchErrors(
      container.repositories,
      imported.batchId,
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert(
      res.headers.get("content-disposition")?.includes("attachment"),
    );
    const text = await res.text();
    const lines = text.trimEnd().split("\n");
    assertEquals(lines[0], "row,external_id,field,code,message,raw_row");
    assert(lines.length >= 2);
    // Formula-injection guard: no CELL may begin with =, +, -, or @. Cells
    // are RFC-4180 quoted, so a cell start is `^"` or `,"`; inner escaped
    // quotes come doubled (`""`) and never form a cell boundary.
    for (const line of lines.slice(1)) {
      assert(!/^"?[=+\-@]/.test(line), "first cell must not start a formula");
      assert(
        !/,"[=+\-@]/.test(line.replaceAll('""', "")),
        "no quoted cell may begin with a formula char",
      );
    }

    const missing = await downloadBatchErrors(
      container.repositories,
      crypto.randomUUID(),
    );
    assertEquals(missing.status, 404);
  });
});
