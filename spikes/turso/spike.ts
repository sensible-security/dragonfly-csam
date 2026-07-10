/**
 * Throwaway spike (DEVELOPMENT_PLAN.md Prompt 0.2): prove the Rust Turso
 * client (npm:@tursodatabase/database) works under Deno — open a local .db
 * file, create a table, insert, select, and run transactions (commit and
 * rollback). Results are documented in FINDINGS.md.
 *
 * Run: deno task spike   (minimal flags — see deno.json)
 */
import { connect, SqliteError } from "@tursodatabase/database";

const DB_FILE = "spike.db";

// Start from a clean slate each run.
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  try {
    await Deno.remove(`${DB_FILE}${suffix}`);
  } catch {
    // didn't exist — fine
  }
}

let failures = 0;

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    console.log(`OK   ${name}${result !== undefined ? ` -> ${JSON.stringify(result)}` : ""}`);
  } catch (err) {
    failures++;
    const detail = err instanceof SqliteError
      ? `SqliteError(${err.code}): ${err.message}`
      : `${(err as Error).name}: ${(err as Error).message}`;
    console.log(`FAIL ${name} -> ${detail}`);
  }
}

console.log(`Deno ${Deno.version.deno} / @tursodatabase/database 0.6.1\n`);

const db = await connect(DB_FILE);
console.log(`OK   connect("${DB_FILE}")`);

await step("exec CREATE TABLE", () =>
  db.exec(
    `CREATE TABLE devices (
       id INTEGER PRIMARY KEY,
       hostname TEXT NOT NULL,
       serial TEXT UNIQUE,
       status TEXT NOT NULL DEFAULT 'pending_review'
         CHECK (status IN ('authorized', 'unauthorized', 'quarantined', 'pending_review', 'decommissioned'))
     )`,
  ));

await step("prepared INSERT with positional params", async () => {
  const stmt = db.prepare("INSERT INTO devices (hostname, serial) VALUES (?, ?)");
  const info = await stmt.run("dc-01.corp.example", "SN-0001");
  return info;
});

await step("prepared INSERT with named params", async () => {
  const stmt = db.prepare(
    "INSERT INTO devices (hostname, serial) VALUES (@hostname, @serial)",
  );
  return await stmt.run({ hostname: "fs-01.corp.example", serial: "SN-0002" });
});

await step("SELECT .all()", async () => {
  const rows = await db.prepare("SELECT id, hostname, serial, status FROM devices ORDER BY id").all();
  if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);
  return rows;
});

await step("SELECT .get() single row", async () => {
  return await db.prepare("SELECT * FROM devices WHERE serial = ?").get("SN-0001");
});

await step("CHECK constraint rejects invalid enum", async () => {
  try {
    await db.exec("INSERT INTO devices (hostname, status) VALUES ('bad', 'not_a_status')");
    throw new Error("insert unexpectedly succeeded — CHECK not enforced!");
  } catch (err) {
    if ((err as Error).message.includes("CHECK")) return "rejected as expected";
    throw err;
  }
});

await step("transaction COMMIT via BEGIN/COMMIT", async () => {
  await db.exec("BEGIN");
  await db.exec("INSERT INTO devices (hostname, serial) VALUES ('tx-1', 'SN-TX1')");
  await db.exec("INSERT INTO devices (hostname, serial) VALUES ('tx-2', 'SN-TX2')");
  await db.exec("COMMIT");
  const row = await db.prepare("SELECT COUNT(*) AS n FROM devices").get();
  return row;
});

await step("transaction ROLLBACK restores state", async () => {
  const before = (await db.prepare("SELECT COUNT(*) AS n FROM devices").get()) as { n: number };
  await db.exec("BEGIN");
  await db.exec("INSERT INTO devices (hostname) VALUES ('doomed')");
  await db.exec("ROLLBACK");
  const after = (await db.prepare("SELECT COUNT(*) AS n FROM devices").get()) as { n: number };
  if (before.n !== after.n) throw new Error(`row count changed ${before.n} -> ${after.n}`);
  return `count stable at ${after.n}`;
});

await step("UNIQUE constraint violation surfaces as error", async () => {
  try {
    await db.exec("INSERT INTO devices (hostname, serial) VALUES ('dup', 'SN-0001')");
    throw new Error("duplicate insert unexpectedly succeeded!");
  } catch (err) {
    if ((err as Error).message.toLowerCase().includes("unique")) return "rejected as expected";
    throw err;
  }
});

await step("PRAGMA foreign_keys (default)", () => db.prepare("PRAGMA foreign_keys").all());

await step("PRAGMA foreign_keys = ON enables FK enforcement", async () => {
  await db.exec("PRAGMA foreign_keys = ON");
  await db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
  await db.exec(
    "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))",
  );
  try {
    await db.exec("INSERT INTO child (pid) VALUES (999)");
    throw new Error("orphan insert unexpectedly succeeded — FKs not enforced!");
  } catch (err) {
    if ((err as Error).message.includes("FOREIGN KEY")) return "orphan rejected as expected";
    throw err;
  }
});
await step("PRAGMA journal_mode", () => db.prepare("PRAGMA journal_mode").all());
await step("json_extract()", () =>
  db.prepare(`SELECT json_extract('{"os":"linux"}', '$.os') AS os`).get());
await step("strftime()/date functions", () =>
  db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS ts").get());
await step("ALTER TABLE ADD COLUMN", () =>
  db.exec("ALTER TABLE devices ADD COLUMN notes TEXT"));
await step("index creation + EXPLAIN", async () => {
  await db.exec("CREATE INDEX idx_devices_serial ON devices (serial)");
  return "index created";
});

db.close();
console.log(`\nDone. ${failures === 0 ? "All steps passed." : `${failures} step(s) FAILED.`}`);
if (failures > 0) Deno.exit(1);
