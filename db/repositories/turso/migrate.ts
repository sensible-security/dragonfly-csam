// CLI entry for `deno task db:migrate`.
import { migrate } from "./migrator.ts";

if (import.meta.main) {
  const dbPath = Deno.env.get("DRAGONFLY_DB_PATH") ?? "data/dragonfly.db";
  const { applied, skipped } = await migrate(dbPath);
  console.log(
    `${dbPath}: ${applied.length} migration(s) applied, ${skipped.length} already applied`,
  );
  for (const filename of applied) {
    console.log(`  + ${filename}`);
  }
}
