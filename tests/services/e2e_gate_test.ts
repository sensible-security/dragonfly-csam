// Phase 3 gate end-to-end test (DEVELOPMENT_PLAN Phase 3 gate; PRD §11.2/§11.4):
// a 50-device CSV plus an overlapping scanner JSON payload ingests, reconciles
// the duplicates (serial matches auto-merge, no new rows), and queues exactly
// one deliberate ambiguity (same MAC, different hostname) for review. Every
// merge wrote an audit entry. Also proves the malformed-CSV path: quarantine +
// duplicate-serial dedup.
import { assert, assertEquals } from "@std/assert";
import { withStack } from "./stack.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";

const USER: AuditContext = { actorType: "user", actorId: "analyst" };
const CONN: AuditContext = { actorType: "connector", actorId: "nessus" };
const PAGE = { limit: 200, offset: 0 };
const SORT = { by: "createdAt", dir: "asc" as const };

const CSV_MAPPING = {
  Host: "hostname",
  Serial: "hardwareSerial",
  MAC: "macAddress",
  Class: "deviceClass",
  Type: "enterpriseAssetType",
  Env: "environment",
  Owner: "owner",
  Dept: "department",
  Crit: "criticality",
  Impact: "businessImpact",
};

function fixture(name: string): Promise<string> {
  return Deno.readTextFile(new URL(`../fixtures/${name}`, import.meta.url));
}

Deno.test("GATE: 50-device CSV + overlapping scanner JSON reconciles duplicates, queues one ambiguity", async () => {
  await withStack(async (s) => {
    // 1. Bulk-import 50 devices. CSV provides required fields → all auto-create.
    const csv = await fixture("devices_clean_50.csv");
    const csvResult = await s.ingestion.ingest({
      sourceType: "csv_import",
      sourceName: "quarterly-inventory",
      payload: csv,
      options: { columnMapping: CSV_MAPPING },
    }, USER);

    assertEquals(csvResult.quarantined.length, 0);
    assertEquals(csvResult.reconciliation.created, 50);
    assertEquals((await s.devices.list({}, PAGE)).total, 50);

    // 2. An overlapping scanner sweep:
    //    - 5 observations matching existing devices by serial → auto-merge.
    //    - 1 deliberate ambiguity: host01's MAC but a different hostname →
    //      weak-key match with a hostname conflict → queued (never merged).
    const scannerObs = [
      ...[1002, 1003, 1004, 1005, 1006].map((n) => ({
        kind: "device",
        externalId: `nessus-ser-${n}`,
        observedAt: "2026-07-11T02:00:00Z",
        matchKeys: { hardwareSerial: `SER-${n}` },
        fields: { environment: "virtual" },
      })),
      {
        kind: "device",
        externalId: "nessus-rogue",
        observedAt: "2026-07-11T02:00:00Z",
        matchKeys: {
          macAddresses: ["AA:BB:CC:01:07:0D"],
          hostname: "rogue-host",
        },
        fields: {},
      },
    ];

    const scanResult = await s.ingestion.ingest({
      sourceType: "scanner_json",
      sourceName: "nessus",
      payload: { observations: scannerObs },
    }, CONN);

    // Duplicates reconciled: 5 auto-merged, no new canonical rows.
    assertEquals(scanResult.reconciliation.autoMerged, 5);
    assertEquals(scanResult.reconciliation.created, 0);
    // Exactly one deliberate ambiguity queued.
    assertEquals(scanResult.reconciliation.queuedForReview, 1);
    assertEquals((await s.devices.list({}, PAGE)).total, 50);

    const queue = await s.reviewQueue.list({}, SORT, PAGE);
    assertEquals(queue.total, 1);
    assertEquals(queue.items[0].reason, "conflicting_field");
    assert(queue.items[0].candidates[0].conflicts.includes("hostname"));

    // Every auto-merge wrote a merge audit entry.
    const merges = await s.auditLog.query({ action: "merge" }, PAGE);
    assertEquals(merges.total, 5);

    // The CSV import wrote 50 device create audit entries.
    const creates = await s.auditLog.query(
      { entityType: "device", action: "create" },
      PAGE,
    );
    assertEquals(creates.total, 50);
  });
});

Deno.test("malformed CSV: bad rows quarantine, duplicate serial dedupes to one device", async () => {
  await withStack(async (s) => {
    const csv = await fixture("devices_malformed.csv");
    const result = await s.ingestion.ingest({
      sourceType: "csv_import",
      sourceName: "messy-import",
      payload: csv,
      options: { columnMapping: CSV_MAPPING },
    }, USER);

    // 4 data rows: goodhost, badcrit (bad enum), missing-key row, duphost.
    assertEquals(result.received, 4);
    // Two rows quarantine (bad criticality enum, no usable match key).
    assertEquals(result.quarantined.length, 2);

    // goodhost + duphost share SER-9001 → deduped to a single canonical device.
    assertEquals((await s.devices.list({}, PAGE)).total, 1);

    // The downloadable error report carries per-row issues.
    const errors = await s.batches.listErrors(result.batchId);
    assertEquals(errors.length, 2);
    const codes = errors.flatMap((e) => e.issues.map((i) => i.code));
    assert(codes.includes("no_match_key"));
  });
});
