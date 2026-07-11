import { connect, type Database } from "@tursodatabase/database";

// The driver alias keeps everything driver-shaped inside this directory;
// callers outside db/repositories/turso/ must depend on interfaces only.
export type DatabaseConnection = Database;

// The only sanctioned way to open the database. PRAGMA foreign_keys defaults
// to OFF in this driver (spikes/turso/FINDINGS.md) — enabling it here, on
// every connection, is load-bearing for FK enforcement.
export async function openDatabase(path: string): Promise<DatabaseConnection> {
  const db = await connect(path);
  await db.exec("PRAGMA foreign_keys = ON");
  return db;
}
