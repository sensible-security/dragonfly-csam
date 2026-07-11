import { dirname, fromFileUrl, join } from "@std/path";
import { openDatabase } from "./connection.ts";

const DEFAULT_MIGRATIONS_DIR = fromFileUrl(
  new URL("../../migrations/", import.meta.url),
);

export class MigrationError extends Error {
  constructor(readonly filename: string, cause: unknown) {
    super(
      `migration ${filename} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "MigrationError";
  }
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

// Applies db/migrations/*.sql in filename order, once each, tracked in the
// _migrations table. Each migration file runs inside its own transaction:
// a failing file is rolled back whole and left unrecorded, so a rerun after
// a fix picks it up again. Forward-only — there is no down().
export async function migrate(
  dbPath: string,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const parent = dirname(dbPath);
  if (parent !== "" && parent !== ".") {
    await Deno.mkdir(parent, { recursive: true });
  }

  const db = await openDatabase(dbPath);
  try {
    await db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    );

    const files: string[] = [];
    for await (const entry of Deno.readDir(migrationsDir)) {
      if (entry.isFile && entry.name.endsWith(".sql")) {
        files.push(entry.name);
      }
    }
    files.sort();

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const filename of files) {
      const seenStmt = await db.prepare(
        "SELECT 1 FROM _migrations WHERE filename = ?",
      );
      const seen = await seenStmt.get(filename);
      if (seen) {
        skipped.push(filename);
        continue;
      }

      const sql = await Deno.readTextFile(join(migrationsDir, filename));
      await db.exec("BEGIN");
      try {
        await db.exec(sql);
        const record = await db.prepare(
          "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)",
        );
        await record.run(filename, new Date().toISOString());
        await db.exec("COMMIT");
      } catch (cause) {
        try {
          await db.exec("ROLLBACK");
        } catch {
          // transaction already aborted — nothing left to roll back
        }
        throw new MigrationError(filename, cause);
      }
      applied.push(filename);
    }

    return { applied, skipped };
  } finally {
    await db.close();
  }
}
