// Shared harness for data-layer tests: temp-file database per test (never
// shared state), applied via the real migration runner, WAL sidecars cleaned
// up with the temp dir. Valid-row builders produce synthetic fixtures only.
import { join } from "@std/path";
import {
  type DatabaseConnection,
  openDatabase,
} from "@/db/repositories/turso/connection.ts";
import { migrate } from "@/db/repositories/turso/migrator.ts";

export async function withTempDb(
  fn: (db: DatabaseConnection, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-test-" });
  const dbPath = join(dir, "test.db");
  await migrate(dbPath);
  const db = await openDatabase(dbPath);
  try {
    await fn(db, dbPath);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

export async function insertRow(
  db: DatabaseConnection,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const stmt = await db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
  );
  await stmt.run(...columns.map((c) => row[c]));
}

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

export function validDeviceRow(overrides: Row = {}): Row {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    device_class: "enterprise_asset",
    enterprise_asset_type: "server",
    end_user_device_subtype: null,
    environment: "physical",
    status: "authorized",
    hostname: "test-host",
    domain: null,
    hardware_serial: null,
    cloud_instance_id: null,
    owner: "IT Ops",
    department: "Engineering",
    criticality: "low",
    business_impact: "test fixture",
    notes: null,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

export function validSoftwareRow(overrides: Row = {}): Row {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    title: `Fixture App ${crypto.randomUUID()}`,
    publisher: "Fixture Corp",
    version: "1.0.0",
    software_type: "application",
    component_type: null,
    authorization_status: "authorized",
    support_status: "supported",
    eol_date: null,
    business_purpose: "test fixture",
    url: null,
    deployment_mechanism: null,
    license_count: null,
    cpe: null,
    decommission_date: null,
    criticality: "low",
    business_impact: "test fixture",
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

export function validNetworkInterfaceRow(
  deviceId: string,
  overrides: Row = {},
): Row {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    device_id: deviceId,
    mac_address: "AA:BB:CC:00:11:22",
    interface_name: null,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

export function validIpAssignmentRow(
  interfaceId: string,
  overrides: Row = {},
): Row {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    interface_id: interfaceId,
    ip_address: "10.0.0.1",
    first_seen: ts,
    last_seen: ts,
    ...overrides,
  };
}

export function validSourceRow(overrides: Row = {}): Row {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    source_type: "manual",
    name: `fixture-source-${crypto.randomUUID()}`,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

export function validSourceRecordRow(
  sourceId: string,
  overrides: Row = {},
): Row {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    source_id: sourceId,
    external_id: crypto.randomUUID(),
    entity_kind: "device",
    raw_payload: "{}",
    normalized_payload: "{}",
    first_seen: ts,
    last_seen: ts,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

export function validFieldProvenanceRow(
  sourceId: string,
  overrides: Row = {},
): Row {
  return {
    id: crypto.randomUUID(),
    entity_type: "device",
    entity_id: crypto.randomUUID(),
    field_name: "hostname",
    source_id: sourceId,
    observed_at: now(),
    ...overrides,
  };
}

export function validAuditLogRow(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    occurred_at: now(),
    actor_type: "user",
    actor_id: "test-user",
    action: "create",
    entity_type: "device",
    entity_id: crypto.randomUUID(),
    before_json: null,
    after_json: null,
    source_address: null,
    ...overrides,
  };
}
