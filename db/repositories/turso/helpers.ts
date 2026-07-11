// Internal plumbing shared by the Turso repository implementations. Driver
// types and SQL never leave this directory (AGENTS.md §4.1).
import {
  DuplicateAssetError,
  NotFoundError,
  TaxonomyViolationError,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";

export const nowIso = (): string => new Date().toISOString();

// Runs fn inside BEGIN/COMMIT so a data change and its audit entry commit or
// roll back together (PRD §3.4 — audit atomicity is a repository invariant).
export async function withTransaction<T>(
  db: DatabaseConnection,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec("BEGIN");
  try {
    const result = await fn();
    await db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // transaction already aborted — nothing left to roll back
    }
    throw err;
  }
}

// Translates driver constraint failures into typed domain errors (PRD §3.5)
// so no caller ever sees a SqliteError. Constraint kind is distinguishable
// from the message text (verified in spikes/turso/FINDINGS.md).
export function translateConstraintError(err: unknown, detail: string): never {
  if (err instanceof Error) {
    if (err.message.includes("UNIQUE")) {
      throw new DuplicateAssetError(detail);
    }
    if (err.message.includes("FOREIGN KEY")) {
      throw new NotFoundError("referenced entity", detail);
    }
    if (err.message.includes("CHECK") || err.message.includes("NOT NULL")) {
      throw new TaxonomyViolationError(`${detail}: ${err.message}`);
    }
  }
  throw err;
}

// Assembles WHERE clause + positional params from optional filter fragments.
export function buildWhere(
  clauses: Array<[condition: string, value: unknown]>,
): { where: string; params: unknown[] } {
  const active = clauses.filter(([, value]) => value !== undefined);
  if (active.length === 0) return { where: "", params: [] };
  return {
    where: ` WHERE ${active.map(([c]) => c).join(" AND ")}`,
    params: active.map(([, value]) => value),
  };
}
