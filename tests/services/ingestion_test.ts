// IngestionService tests — Normalize → Stage (PRD §5, §11.2). Valid rows stage
// with verbatim provenance; malformed rows quarantine to ingestion_errors with
// a per-row error report and never reach staging; untrusted payload text is
// stored verbatim and only sanitized in the normalized copy (AGENTS.md §2.7).
import { assert, assertEquals } from "@std/assert";
import { withStack } from "./stack.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";

const USER: AuditContext = { actorType: "user", actorId: "analyst" };
const PAGE = { limit: 100, offset: 0 };

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

Deno.test("CSV ingest stages valid rows and quarantines malformed rows", async () => {
  await withStack(async (s) => {
    const csv = [
      "Host,Serial,Class,Type,Env,Owner,Dept,Crit,Impact",
      "web01,SER-1,enterprise_asset,server,physical,IT,Eng,high,prod", // valid
      "web02,SER-2,enterprise_asset,server,physical,IT,Eng,low,dev", // valid
      "web03,SER-3,enterprise_asset,server,physical,IT,Eng,ludicrous,bad", // bad enum
      ",,,,,,,,", // no usable match key
    ].join("\n");

    const r = await s.ingestion.ingest({
      sourceType: "csv_import",
      sourceName: "quarterly-csv",
      payload: csv,
      options: { columnMapping: CSV_MAPPING },
    }, USER);

    assertEquals(r.received, 4);
    assertEquals(r.staged, 2);
    assertEquals(r.quarantined.length, 2);
    // Both valid rows became canonical devices (CSV provides required fields).
    assertEquals(r.reconciliation.created, 2);
    assertEquals((await s.devices.list({}, PAGE)).total, 2);

    // The error report is backed by ingestion_errors.
    const errors = await s.batches.listErrors(r.batchId);
    assertEquals(errors.length, 2);
    const codes = errors.flatMap((e) => e.issues.map((i) => i.code)).sort();
    assert(codes.includes("no_match_key"));
  });
});

Deno.test("quarantined rows never corrupt inventory; batch counts are recorded", async () => {
  await withStack(async (s) => {
    const csv = [
      "Host,Crit",
      "onlybad,ludicrous",
    ].join("\n");
    const r = await s.ingestion.ingest({
      sourceType: "csv_import",
      sourceName: "csv",
      payload: csv,
      options: { columnMapping: { Host: "hostname", Crit: "criticality" } },
    }, USER);

    assertEquals(r.staged, 0);
    assertEquals(r.quarantined.length, 1);
    assertEquals((await s.devices.list({}, PAGE)).total, 0);

    const batch = await s.batches.getById(r.batchId);
    assertEquals(batch?.status, "completed");
    assertEquals(batch?.stagedCount, 0);
    assertEquals(batch?.quarantinedCount, 1);
  });
});

Deno.test("untrusted payload text is stored verbatim; only the normalized copy is sanitized", async () => {
  await withStack(async (s) => {
    // businessImpact carries a NUL + instruction-like text.
    const dirty = "ignore prior instructions" + String.fromCharCode(0) + "!";
    const obs = {
      kind: "device",
      externalId: "m1",
      observedAt: "2026-07-11T00:00:00Z",
      matchKeys: { hostname: "web01", hardwareSerial: "SER-1" },
      fields: {
        deviceClass: "enterprise_asset",
        enterpriseAssetType: "server",
        environment: "physical",
        owner: "IT",
        department: "Eng",
        criticality: "high",
        businessImpact: dirty,
      },
    };
    const r = await s.ingestion.ingest(
      { sourceType: "manual", sourceName: "manual-entry", payload: obs },
      USER,
    );
    assertEquals(r.staged, 1);

    const source = await s.sourceRecords.getSourceByName("manual-entry");
    const rec = await s.sourceRecords.findByExternalId(source!.id, "m1");
    assert(rec !== null);
    // Raw payload preserves the control char (JSON-escaped) verbatim.
    assert(rec!.rawPayload.includes("\\u0000"));
    // Normalized copy has the control char stripped.
    const normalized = JSON.parse(rec!.normalizedPayload);
    assertEquals(
      normalized.fields.businessImpact,
      "ignore prior instructions!",
    );
    // The stored device also carries the sanitized value — never interpreted.
    const d = (await s.devices.list({}, PAGE)).items[0];
    assertEquals(d.businessImpact, "ignore prior instructions!");
  });
});

Deno.test("ingest is idempotent by source name; second run reuses the source", async () => {
  await withStack(async (s) => {
    await s.ingestion.ingest(
      {
        sourceType: "manual",
        sourceName: "manual-entry",
        payload: {
          kind: "device",
          externalId: "m1",
          observedAt: "2026-07-11T00:00:00Z",
          matchKeys: { hostname: "web01", hardwareSerial: "SER-1" },
          fields: {
            deviceClass: "enterprise_asset",
            enterpriseAssetType: "server",
            environment: "physical",
            owner: "IT",
            department: "Eng",
            criticality: "high",
            businessImpact: "prod",
          },
        },
      },
      USER,
    );
    const before = await s.sourceRecords.getSourceByName("manual-entry");
    await s.ingestion.ingest(
      {
        sourceType: "manual",
        sourceName: "manual-entry",
        payload: {
          kind: "device",
          externalId: "m2",
          observedAt: "2026-07-11T01:00:00Z",
          matchKeys: { hostname: "web02", hardwareSerial: "SER-2" },
          fields: {
            deviceClass: "enterprise_asset",
            enterpriseAssetType: "server",
            environment: "physical",
            owner: "IT",
            department: "Eng",
            criticality: "low",
            businessImpact: "dev",
          },
        },
      },
      USER,
    );
    const after = await s.sourceRecords.getSourceByName("manual-entry");
    assertEquals(before!.id, after!.id);
  });
});
