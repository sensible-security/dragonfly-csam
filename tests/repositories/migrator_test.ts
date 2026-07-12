import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { openDatabase } from "@/db/repositories/turso/connection.ts";
import { migrate, MigrationError } from "@/db/repositories/turso/migrator.ts";
import { insertRow, validNetworkInterfaceRow, withTempDb } from "./helpers.ts";

Deno.test("migrate applies all migrations to a fresh database and reruns are no-ops", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-migrate-" });
  const dbPath = join(dir, "test.db");
  const ALL = ["0001_initial.sql", "0002_ingestion.sql", "0003_auth.sql"];
  try {
    const first = await migrate(dbPath);
    assertEquals(first.applied, ALL);
    assertEquals(first.skipped, []);

    const second = await migrate(dbPath);
    assertEquals(second.applied, []);
    assertEquals(second.skipped, ALL);

    const db = await openDatabase(dbPath);
    try {
      const stmt = await db.prepare("SELECT COUNT(*) AS n FROM _migrations");
      const row = await stmt.get();
      assertEquals(row.n, ALL.length);
      // Spot-check that the schema actually exists.
      for (
        const table of [
          "devices",
          "network_interfaces",
          "ip_assignments",
          "software",
          "device_software",
          "exceptions",
          "service_providers",
          "sources",
          "source_records",
          "field_provenance",
          "audit_log",
          "ingestion_batches",
          "ingestion_errors",
          "review_queue",
          "users",
          "sessions",
          "api_keys",
        ]
      ) {
        const probe = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
        assertEquals((await probe.get()).n, 0, `table ${table} missing`);
      }
    } finally {
      await db.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failing migration rolls back whole and stays unrecorded", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-migrate-bad-" });
  const migrationsDir = join(dir, "migrations");
  await Deno.mkdir(migrationsDir);
  await Deno.writeTextFile(
    join(migrationsDir, "0001_ok.sql"),
    "CREATE TABLE t (n INTEGER CHECK (n >= 0));",
  );
  await Deno.writeTextFile(
    join(migrationsDir, "0002_bad.sql"),
    "INSERT INTO t (n) VALUES (1);\nINSERT INTO t (n) VALUES (-1);",
  );
  const dbPath = join(dir, "test.db");
  try {
    await assertRejects(
      () => migrate(dbPath, migrationsDir),
      MigrationError,
      "0002_bad.sql",
    );

    const db = await openDatabase(dbPath);
    try {
      const applied = await (await db.prepare(
        "SELECT filename FROM _migrations ORDER BY filename",
      )).all();
      assertEquals(applied.map((r) => r.filename), ["0001_ok.sql"]);
      // The valid first INSERT of 0002 must have been rolled back with it.
      const count = await (await db.prepare("SELECT COUNT(*) AS n FROM t"))
        .get();
      assertEquals(count.n, 0);
    } finally {
      await db.close();
    }

    // A rerun retries the unrecorded migration (still failing here).
    await assertRejects(() => migrate(dbPath, migrationsDir), MigrationError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("connection factory turns foreign key enforcement ON", async () => {
  await withTempDb(async (db) => {
    const pragma = await (await db.prepare("PRAGMA foreign_keys")).get();
    assertEquals(Object.values(pragma)[0], 1);
    // And it actually bites: orphan insert rejected.
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
  });
});
