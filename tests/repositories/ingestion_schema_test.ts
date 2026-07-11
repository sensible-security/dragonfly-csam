// Ingestion schema tests (0002_ingestion.sql): every new enum CHECK rejects an
// out-of-enum value; the sources rebuild pins source_type and preserves rows;
// TS↔SQL enum parity for the ingestion enums; precedence default. Same temp-DB
// harness as the core schema tests.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  BATCH_STATUSES,
  RECONCILIATION_STATUSES,
  REVIEW_CONFIDENCES,
  REVIEW_REASONS,
  REVIEW_STATUSES,
  SOURCE_TYPES,
} from "@/db/repositories/interfaces/ingestion.ts";
import {
  AUDIT_ACTOR_TYPES,
  PROVENANCE_ENTITY_TYPES,
} from "@/db/repositories/interfaces/taxonomy.ts";
import { openDatabase } from "@/db/repositories/turso/connection.ts";
import { migrate } from "@/db/repositories/turso/migrator.ts";
import {
  insertRow,
  validIngestionBatchRow,
  validReviewQueueRow,
  validSourceRecordRow,
  validSourceRow,
  withTempDb,
} from "./helpers.ts";

const JUNK = "__not_in_enum__";

Deno.test("every ingestion enum CHECK rejects an out-of-enum value", async () => {
  await withTempDb(async (db) => {
    const source = validSourceRow();
    await insertRow(db, "sources", source);
    const sourceId = source.id as string;
    const record = validSourceRecordRow(sourceId);
    await insertRow(db, "source_records", record);
    const batch = validIngestionBatchRow(sourceId);
    await insertRow(db, "ingestion_batches", batch);

    const cases: Array<
      { table: string; column: string; row: Record<string, unknown> }
    > = [
      { table: "sources", column: "source_type", row: validSourceRow() },
      {
        table: "ingestion_batches",
        column: "status",
        row: validIngestionBatchRow(sourceId),
      },
      {
        table: "ingestion_batches",
        column: "actor_type",
        row: validIngestionBatchRow(sourceId),
      },
      {
        table: "review_queue",
        column: "entity_kind",
        row: validReviewQueueRow(record.id as string),
      },
      {
        table: "review_queue",
        column: "reason",
        row: validReviewQueueRow(record.id as string),
      },
      {
        table: "review_queue",
        column: "confidence",
        row: validReviewQueueRow(record.id as string),
      },
      {
        table: "review_queue",
        column: "status",
        row: validReviewQueueRow(record.id as string),
      },
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

Deno.test("source_records reconciliation columns are CHECK-constrained", async () => {
  await withTempDb(async (db) => {
    const source = validSourceRow();
    await insertRow(db, "sources", source);
    const sourceId = source.id as string;

    await assertRejects(
      () =>
        insertRow(
          db,
          "source_records",
          validSourceRecordRow(sourceId, { reconciliation_status: JUNK }),
        ),
      Error,
      "CHECK",
    );
    await assertRejects(
      () =>
        insertRow(
          db,
          "source_records",
          validSourceRecordRow(sourceId, { matched_entity_type: JUNK }),
        ),
      Error,
      "CHECK",
    );
    // Valid outcome columns are accepted.
    await insertRow(
      db,
      "source_records",
      validSourceRecordRow(sourceId, {
        reconciliation_status: "auto_merged",
        matched_entity_type: "device",
        matched_entity_id: crypto.randomUUID(),
        reconciled_at: new Date().toISOString(),
      }),
    );
  });
});

Deno.test("source_records defaults reconciliation_status to 'pending'", async () => {
  await withTempDb(async (db) => {
    const source = validSourceRow();
    await insertRow(db, "sources", source);
    const record = validSourceRecordRow(source.id as string);
    await insertRow(db, "source_records", record);
    const stmt = await db.prepare(
      "SELECT reconciliation_status FROM source_records WHERE id = ?",
    );
    const got = await stmt.get(record.id) as { reconciliation_status: string };
    assertEquals(got.reconciliation_status, "pending");
  });
});

Deno.test("sources.precedence defaults to 50 when unspecified", async () => {
  await withTempDb(async (db) => {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    // Insert without the precedence column — the schema default must apply.
    const stmt = await db.prepare(
      "INSERT INTO sources (id, source_type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    await stmt.run(id, "csv_import", "no-precedence-source", ts, ts);
    const got = await (await db.prepare(
      "SELECT precedence FROM sources WHERE id = ?",
    )).get(id) as { precedence: number };
    assertEquals(got.precedence, 50);
  });
});

Deno.test("the sources rebuild pins source_type and preserves pre-existing rows", async () => {
  // Apply 0001 alone, seed a source, then apply 0002 — the 12-step rebuild must
  // carry the row through and thereafter reject an out-of-enum source_type.
  const migrationsDir = fromFileUrl(
    new URL("../../db/migrations/", import.meta.url),
  );
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-rebuild-" });
  try {
    const stagedMigrations = join(dir, "migrations");
    await Deno.mkdir(stagedMigrations);
    await Deno.copyFile(
      join(migrationsDir, "0001_initial.sql"),
      join(stagedMigrations, "0001_initial.sql"),
    );
    const dbPath = join(dir, "test.db");
    await migrate(dbPath, stagedMigrations);

    // Seed a source before 0002 exists (pre-rebuild row).
    const seedDb = await openDatabase(dbPath);
    const ts = new Date().toISOString();
    await (await seedDb.prepare(
      "INSERT INTO sources (id, source_type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )).run("seed-1", "manual", "legacy-source", ts, ts);
    await seedDb.close();

    // Now apply 0002 (the rebuild).
    await Deno.copyFile(
      join(migrationsDir, "0002_ingestion.sql"),
      join(stagedMigrations, "0002_ingestion.sql"),
    );
    await migrate(dbPath, stagedMigrations);

    const db = await openDatabase(dbPath);
    try {
      const preserved = await (await db.prepare(
        "SELECT id, source_type, name, precedence FROM sources WHERE id = ?",
      )).get("seed-1") as {
        id: string;
        source_type: string;
        name: string;
        precedence: number;
      };
      assertEquals(preserved.id, "seed-1");
      assertEquals(preserved.source_type, "manual");
      assertEquals(preserved.name, "legacy-source");
      assertEquals(preserved.precedence, 50); // ADD COLUMN default backfilled

      // The CHECK is now live.
      await assertRejects(
        () =>
          (async () => {
            await (await db.prepare(
              "INSERT INTO sources (id, source_type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )).run("bad-1", JUNK, "bad-source", ts, ts);
          })(),
        Error,
        "CHECK",
      );
    } finally {
      await db.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ingestion TS enum arrays and SQL CHECK lists cannot drift", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../db/migrations/0002_ingestion.sql", import.meta.url),
  );

  // Every enum a CHECK in 0002 may legitimately reference (reused core enums
  // included). Two different columns are named `status`, so parity is proven by
  // set-membership rather than by column name.
  const known: Record<string, readonly string[]> = {
    SOURCE_TYPES,
    RECONCILIATION_STATUSES,
    BATCH_STATUSES,
    REVIEW_REASONS,
    REVIEW_CONFIDENCES,
    REVIEW_STATUSES,
    PROVENANCE_ENTITY_TYPES,
    AUDIT_ACTOR_TYPES,
  };
  const asSet = (xs: readonly string[]) => new Set(xs);
  const setEq = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));

  const checkList = /CHECK \((\w+) IN \(([^)]*)\)\)/g;
  const extracted: Set<string>[] = [];
  for (const match of sql.matchAll(checkList)) {
    const values = match[2]
      .split(",")
      .map((v) => v.trim().replace(/^'(.*)'$/, "$1"));
    const set = asSet(values);
    // Each extracted CHECK list must equal exactly one known enum.
    const matchName = Object.entries(known).find(([, arr]) =>
      setEq(set, asSet(arr))
    );
    assert(
      matchName !== undefined,
      `CHECK on ${match[1]} = {${[...set]}} matches no known enum`,
    );
    extracted.push(set);
  }

  // Each ingestion enum must be represented by at least one CHECK in 0002.
  for (
    const [name, arr] of Object.entries({
      SOURCE_TYPES,
      RECONCILIATION_STATUSES,
      BATCH_STATUSES,
      REVIEW_REASONS,
      REVIEW_CONFIDENCES,
      REVIEW_STATUSES,
    })
  ) {
    assert(
      extracted.some((s) => setEq(s, asSet(arr))),
      `no CHECK in 0002 matches ingestion enum ${name}`,
    );
  }
});
