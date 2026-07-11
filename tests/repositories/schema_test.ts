// Schema tests (PLAN task A6): every enum CHECK, both device hierarchy
// CHECKs, the software component hierarchy CHECK, NOT NULL on
// criticality/business_impact, FK enforcement, and TS↔SQL enum parity.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ASSET_STATUSES,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  CRITICALITIES,
  DEVICE_CLASSES,
  END_USER_DEVICE_SUBTYPES,
  ENTERPRISE_ASSET_TYPES,
  ENVIRONMENTS,
  PROVENANCE_ENTITY_TYPES,
  SOFTWARE_ASSET_TYPES,
  SOFTWARE_AUTHORIZATION_STATUSES,
  SOFTWARE_COMPONENT_TYPES,
  SUPPORT_STATUSES,
} from "@/db/repositories/interfaces/taxonomy.ts";
import {
  insertRow,
  validAuditLogRow,
  validDeviceRow,
  validFieldProvenanceRow,
  validIpAssignmentRow,
  validNetworkInterfaceRow,
  validSoftwareRow,
  validSourceRecordRow,
  validSourceRow,
  withTempDb,
} from "./helpers.ts";

const JUNK = "__not_in_enum__";

Deno.test("every enum CHECK rejects an out-of-enum value", async () => {
  await withTempDb(async (db) => {
    const source = validSourceRow();
    await insertRow(db, "sources", source);
    const sourceId = source.id as string;

    const cases: Array<{
      table: string;
      column: string;
      row: Record<string, unknown>;
    }> = [
      { table: "devices", column: "device_class", row: validDeviceRow() },
      {
        table: "devices",
        column: "enterprise_asset_type",
        row: validDeviceRow(),
      },
      {
        table: "devices",
        column: "end_user_device_subtype",
        row: validDeviceRow({ enterprise_asset_type: "end_user_device" }),
      },
      { table: "devices", column: "environment", row: validDeviceRow() },
      { table: "devices", column: "status", row: validDeviceRow() },
      { table: "devices", column: "criticality", row: validDeviceRow() },
      { table: "software", column: "software_type", row: validSoftwareRow() },
      { table: "software", column: "component_type", row: validSoftwareRow() },
      {
        table: "software",
        column: "authorization_status",
        row: validSoftwareRow(),
      },
      { table: "software", column: "support_status", row: validSoftwareRow() },
      { table: "software", column: "criticality", row: validSoftwareRow() },
      {
        table: "source_records",
        column: "entity_kind",
        row: validSourceRecordRow(sourceId),
      },
      {
        table: "field_provenance",
        column: "entity_type",
        row: validFieldProvenanceRow(sourceId),
      },
      { table: "audit_log", column: "actor_type", row: validAuditLogRow() },
      { table: "audit_log", column: "action", row: validAuditLogRow() },
    ];

    for (const { table, column, row } of cases) {
      await assertRejects(
        () => insertRow(db, table, { ...row, [column]: JUNK }),
        Error,
        "CHECK",
        `${table}.${column} accepted an out-of-enum value`,
      );
    }
  });
});

Deno.test("device hierarchy CHECKs reject invalid combinations", async () => {
  await withTempDb(async (db) => {
    // removable_media must not carry an enterprise asset type.
    await assertRejects(
      () =>
        insertRow(
          db,
          "devices",
          validDeviceRow({
            device_class: "removable_media",
            enterprise_asset_type: "server",
          }),
        ),
      Error,
      "CHECK",
    );
    // enterprise_asset must carry one.
    await assertRejects(
      () =>
        insertRow(
          db,
          "devices",
          validDeviceRow({
            device_class: "enterprise_asset",
            enterprise_asset_type: null,
          }),
        ),
      Error,
      "CHECK",
    );
    // Subtype is only valid on end_user_device.
    await assertRejects(
      () =>
        insertRow(
          db,
          "devices",
          validDeviceRow({
            enterprise_asset_type: "server",
            end_user_device_subtype: "portable",
          }),
        ),
      Error,
      "CHECK",
    );
  });
});

Deno.test("software hierarchy CHECK rejects component_type on firmware", async () => {
  await withTempDb(async (db) => {
    await assertRejects(
      () =>
        insertRow(
          db,
          "software",
          validSoftwareRow({
            software_type: "firmware",
            component_type: "library",
          }),
        ),
      Error,
      "CHECK",
    );
  });
});

Deno.test("valid taxonomy combinations are accepted", async () => {
  await withTempDb(async (db) => {
    // Removable media: no asset type, no subtype.
    await insertRow(
      db,
      "devices",
      validDeviceRow({
        device_class: "removable_media",
        enterprise_asset_type: null,
      }),
    );
    // End-user device with the ordered subtype (mobile ⊂ portable).
    await insertRow(
      db,
      "devices",
      validDeviceRow({
        enterprise_asset_type: "end_user_device",
        end_user_device_subtype: "mobile",
      }),
    );
    // OS-level component.
    await insertRow(
      db,
      "software",
      validSoftwareRow({
        software_type: "operating_system",
        component_type: "service",
      }),
    );
  });
});

Deno.test("criticality and business_impact are NOT NULL on both asset tables", async () => {
  await withTempDb(async (db) => {
    for (
      const [table, row] of [
        ["devices", validDeviceRow],
        ["software", validSoftwareRow],
      ] as const
    ) {
      await assertRejects(
        () => insertRow(db, table, row({ criticality: null })),
        Error,
        "NOT NULL",
        `${table}.criticality accepted NULL`,
      );
      await assertRejects(
        () => insertRow(db, table, row({ business_impact: null })),
        Error,
        "NOT NULL",
        `${table}.business_impact accepted NULL`,
      );
    }
  });
});

Deno.test("license_count CHECK rejects negative values", async () => {
  await withTempDb(async (db) => {
    await assertRejects(
      () => insertRow(db, "software", validSoftwareRow({ license_count: -1 })),
      Error,
      "CHECK",
    );
    await insertRow(db, "software", validSoftwareRow({ license_count: 0 }));
  });
});

Deno.test("foreign keys are enforced on child tables", async () => {
  await withTempDb(async (db) => {
    await assertRejects(
      () =>
        insertRow(
          db,
          "network_interfaces",
          validNetworkInterfaceRow("no-such-device"),
        ),
      Error,
      "FOREIGN KEY",
    );
    await assertRejects(
      () =>
        insertRow(
          db,
          "ip_assignments",
          validIpAssignmentRow("no-such-interface"),
        ),
      Error,
      "FOREIGN KEY",
    );
    await assertRejects(
      () =>
        insertRow(
          db,
          "source_records",
          validSourceRecordRow("no-such-source"),
        ),
      Error,
      "FOREIGN KEY",
    );
  });
});

Deno.test("TS taxonomy arrays and SQL CHECK lists cannot drift", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../db/migrations/0001_initial.sql", import.meta.url),
  );

  // Column name → the TS source-of-truth array. audit_log.entity_type is an
  // open set (no CHECK), so only field_provenance.entity_type matches below.
  const expected: Record<string, readonly string[]> = {
    device_class: DEVICE_CLASSES,
    enterprise_asset_type: ENTERPRISE_ASSET_TYPES,
    end_user_device_subtype: END_USER_DEVICE_SUBTYPES,
    environment: ENVIRONMENTS,
    status: ASSET_STATUSES,
    criticality: CRITICALITIES,
    software_type: SOFTWARE_ASSET_TYPES,
    component_type: SOFTWARE_COMPONENT_TYPES,
    authorization_status: SOFTWARE_AUTHORIZATION_STATUSES,
    support_status: SUPPORT_STATUSES,
    entity_kind: PROVENANCE_ENTITY_TYPES,
    entity_type: PROVENANCE_ENTITY_TYPES,
    actor_type: AUDIT_ACTOR_TYPES,
    action: AUDIT_ACTIONS,
  };

  // Matches single-line enum CHECKs only — the multi-line hierarchy CHECKs
  // are deliberately out of scope here (covered by behavior tests above).
  const checkList = /CHECK \((\w+) IN \(([^)]*)\)\)/g;
  const seen = new Set<string>();
  for (const match of sql.matchAll(checkList)) {
    const column = match[1];
    const values = match[2]
      .split(",")
      .map((v) => v.trim().replace(/^'(.*)'$/, "$1"));
    const source = expected[column];
    assert(
      source !== undefined,
      `migration has an enum CHECK on unexpected column ${column}`,
    );
    assertEquals(
      values,
      [...source],
      `CHECK list for ${column} drifted from taxonomy.ts`,
    );
    seen.add(column);
  }
  for (const column of Object.keys(expected)) {
    assert(seen.has(column), `no enum CHECK found for column ${column}`);
  }
});
