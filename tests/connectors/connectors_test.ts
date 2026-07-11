// Connector-layer unit tests (PRD §11.2): normalize is pure and total (bad row
// → RowError, never throws); registry open/closed; CSV column-mapping + malformed
// quarantine; scanner envelope validation; untrusted free-text is sanitized to
// inert data (AGENTS.md §2.7).
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ConnectorRegistry,
  createCsvConnector,
  createManualConnector,
  createScannerJsonConnector,
  InvalidEnvelopeError,
} from "@/connectors/mod.ts";
import type { ConnectorContext } from "@/connectors/mod.ts";

const CTX: ConnectorContext = {
  sourceId: "src-1",
  observedAt: "2026-07-11T00:00:00Z",
};

function deviceObs(overrides: Record<string, unknown> = {}) {
  return {
    kind: "device",
    externalId: "e1",
    observedAt: "2026-07-11T00:00:00Z",
    matchKeys: { hostname: "web01", domain: "corp" },
    fields: {
      deviceClass: "enterprise_asset",
      enterpriseAssetType: "server",
      environment: "physical",
      owner: "IT",
      department: "Eng",
      criticality: "high",
      businessImpact: "prod",
    },
    ...overrides,
  };
}

Deno.test("registry maps sourceType→connector; require throws on unknown; no dup", () => {
  const reg = new ConnectorRegistry().register(createManualConnector());
  assertEquals(reg.get("manual")?.sourceType, "manual");
  assert(reg.has("manual"));
  assertEquals(reg.get("csv_import"), undefined);
  assertThrows(
    () => reg.require("csv_import"),
    Error,
    "no connector registered",
  );
  assertThrows(
    () => reg.register(createManualConnector()),
    Error,
    "already registered",
  );
});

Deno.test("manual connector: receive wraps one submission; normalize validates", async () => {
  const c = createManualConnector();
  const raws = await c.receive!(deviceObs(), CTX);
  assertEquals(raws.length, 1);
  assertEquals(raws[0].externalId, "e1");

  const result = c.normalize(raws[0]);
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.observation.kind, "device");
    assertEquals(result.observation.externalId, "e1");
  }
});

Deno.test("manual connector: missing observedAt is filled from ctx clock", async () => {
  const c = createManualConnector();
  const obs = deviceObs();
  delete (obs as Record<string, unknown>).observedAt;
  const raws = await c.receive!(obs, CTX);
  const result = c.normalize(raws[0]);
  assert(result.ok);
  if (result.ok) assertEquals(result.observation.observedAt, CTX.observedAt);
});

Deno.test("normalize is total: bad enum → RowError, never throws", async () => {
  const c = createManualConnector();
  const raws = await c.receive!(
    deviceObs({
      fields: { ...deviceObs().fields, criticality: "SUPER_CRITICAL" },
    }),
    CTX,
  );
  const result = c.normalize(raws[0]);
  assert(!result.ok);
  if (!result.ok) {
    assert(result.error.issues.some((i) => i.field.includes("criticality")));
  }
});

Deno.test("normalize is total: malformed JSON payload → RowError", () => {
  const c = createManualConnector();
  const result = c.normalize({
    externalId: "x",
    payload: "{not json",
    rowRef: 0,
  });
  assert(!result.ok);
  if (!result.ok) assertEquals(result.error.issues[0].code, "invalid_json");
});

Deno.test("free-text is sanitized: control chars stripped from normalized value", async () => {
  const c = createManualConnector();
  const dirty = "prod" + String.fromCharCode(0) + String.fromCharCode(7) +
    "system";
  const raws = await c.receive!(
    deviceObs({ fields: { ...deviceObs().fields, businessImpact: dirty } }),
    CTX,
  );
  const result = c.normalize(raws[0]);
  assert(result.ok);
  if (result.ok && result.observation.kind === "device") {
    assertEquals(result.observation.fields.businessImpact, "prodsystem");
  }
});

Deno.test("MAC addresses normalize to uppercase colon form", async () => {
  const c = createManualConnector();
  const raws = await c.receive!(
    deviceObs({
      matchKeys: { macAddresses: ["001a.2b3c.4d5e"], hostname: "h" },
    }),
    CTX,
  );
  const result = c.normalize(raws[0]);
  assert(result.ok);
  if (result.ok && result.observation.kind === "device") {
    assertEquals(result.observation.matchKeys.macAddresses, [
      "00:1A:2B:3C:4D:5E",
    ]);
  }
});

Deno.test("scanner connector: valid envelope → per-observation raw records", async () => {
  const c = createScannerJsonConnector();
  const raws = await c.receive!({
    observedAt: "2026-07-11T02:00:00Z",
    observations: [
      {
        kind: "device",
        externalId: "h1",
        matchKeys: { hostname: "a" },
        fields: {},
      },
      {
        kind: "device",
        externalId: "h2",
        matchKeys: { hostname: "b" },
        fields: {},
      },
    ],
  }, CTX);
  assertEquals(raws.length, 2);
  assertEquals(raws.map((r) => r.externalId), ["h1", "h2"]);
});

Deno.test("scanner connector: invalid envelope throws InvalidEnvelopeError (→400)", () => {
  const c = createScannerJsonConnector();
  assertThrows(
    () => c.receive!({ observations: [] }, CTX),
    InvalidEnvelopeError,
  );
  assertThrows(() => c.receive!({ nope: true }, CTX), InvalidEnvelopeError);
});

Deno.test("scanner connector: a bad observation quarantines per-row (normalize)", async () => {
  const c = createScannerJsonConnector();
  const raws = await c.receive!({
    observations: [
      {
        kind: "device",
        externalId: "ok",
        matchKeys: { hostname: "a" },
        fields: {},
      },
      {
        kind: "device",
        externalId: "bad",
        matchKeys: { macAddresses: ["not-a-mac"] },
        fields: {},
      },
    ],
  }, CTX);
  assert(c.normalize(raws[0]).ok);
  const bad = c.normalize(raws[1]);
  assert(!bad.ok);
});

Deno.test("CSV connector: column mapping builds a device observation", async () => {
  const c = createCsvConnector();
  const csv = [
    "Host,Serial,MAC,Env,Owner,Dept,Crit,Impact",
    "web01,SER-1,00:1A:2B:3C:4D:5E,physical,IT,Eng,high,prod",
  ].join("\n");
  const ctx: ConnectorContext = {
    ...CTX,
    options: {
      columnMapping: {
        Host: "hostname",
        Serial: "hardwareSerial",
        MAC: "macAddress",
        Env: "environment",
        Owner: "owner",
        Dept: "department",
        Crit: "criticality",
        Impact: "businessImpact",
      },
    },
  };
  const raws = await c.receive!(csv, ctx);
  assertEquals(raws.length, 1);
  const result = c.normalize(raws[0]);
  assert(result.ok);
  if (result.ok && result.observation.kind === "device") {
    const o = result.observation;
    assertEquals(o.matchKeys.hostname, "web01");
    assertEquals(o.matchKeys.hardwareSerial, "SER-1");
    assertEquals(o.matchKeys.macAddresses, ["00:1A:2B:3C:4D:5E"]);
    assertEquals(o.fields.criticality, "high");
    assertEquals(o.interfaces?.[0].macAddress, "00:1A:2B:3C:4D:5E");
  }
});

Deno.test("CSV connector: bad criticality enum → quarantined RowError", async () => {
  const c = createCsvConnector();
  const csv = "Host,Crit\nweb01,ludicrous";
  const raws = await c.receive!(csv, {
    ...CTX,
    options: { columnMapping: { Host: "hostname", Crit: "criticality" } },
  });
  const result = c.normalize(raws[0]);
  assert(!result.ok);
  if (!result.ok) {
    assert(result.error.issues.some((i) => i.field.includes("criticality")));
  }
});

Deno.test("CSV connector: row with no usable match key → quarantined", async () => {
  const c = createCsvConnector();
  // Only a department column mapped — no serial/MAC/hostname → no match key.
  const csv = "Dept\nEng";
  const raws = await c.receive!(csv, {
    ...CTX,
    options: { columnMapping: { Dept: "department" } },
  });
  const result = c.normalize(raws[0]);
  assert(!result.ok);
  if (!result.ok) assertEquals(result.error.issues[0].code, "no_match_key");
});

Deno.test("CSV parser handles quoted fields with embedded commas", async () => {
  const c = createCsvConnector();
  const csv = 'Host,Impact\nweb01,"revenue, critical"';
  const raws = await c.receive!(csv, {
    ...CTX,
    options: { columnMapping: { Host: "hostname", Impact: "businessImpact" } },
  });
  const result = c.normalize(raws[0]);
  assert(result.ok);
  if (result.ok && result.observation.kind === "device") {
    assertEquals(result.observation.fields.businessImpact, "revenue, critical");
  }
});
