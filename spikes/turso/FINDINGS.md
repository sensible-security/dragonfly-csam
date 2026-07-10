# Turso Spike Findings (Prompt 0.2)

**Date:** 2026-07-10 · **Package:** `npm:@tursodatabase/database@0.6.1` (Rust Turso rewrite, embedded)
**Verified on:** Deno 2.9.2 — Windows 11 host (win32-x64) **and** `denoland/deno:2.9.2` Linux container (linux-x64-gnu). All 17 spike steps passed in both environments.

## Verdict

**GO.** The client opens a local `.db` file in-process, and every operation the data layer needs worked: DDL, prepared inserts (positional + named params), selects, transactions (commit + rollback), CHECK/UNIQUE/FK constraint enforcement, `ALTER TABLE ADD COLUMN`, index creation, JSON and date functions.

## How to reproduce

```bash
cd spikes/turso
deno install        # native binding arrives via npm optionalDependencies
deno task spike     # minimal permission flags
```

In the Deno container:

```bash
docker run --rm -v "$PWD/spikes/turso:/src:ro" denoland/deno:2.9.2 \
  sh -c "mkdir -p /tmp/spike && cp /src/deno.json /src/spike.ts /tmp/spike/ && cd /tmp/spike && deno install && deno task spike"
```

## Permission flags required

`--allow-read --allow-write --allow-ffi --allow-env` was sufficient (see the `spike` task). Notes:

- `--allow-ffi` is required — the client is a napi native addon (`.node` binary).
- `--allow-read` must at minimum cover `node_modules/` (addon loading) plus the `.db` file directory; `--allow-write` covers the `.db`/`-wal`/`-shm` files. Path-scoped narrowing was not exhaustively tested; broad flags are fine inside the container.
- No `--allow-net`: fully embedded, zero network. Confirms AGENTS.md — no libSQL/sqld/HTTP anywhere.
- `deno install` needed no `--allow-scripts` (prebuilt binaries via `optionalDependencies`: win32-x64-msvc, linux-x64-gnu, linux-arm64-gnu, darwin-arm64 — no postinstall).

## API shape and quirks

- **Promise-based, not better-sqlite3-sync.** Main entry is `dist/promise.js`; exports `connect`, `Database`, `SqliteError`. Usage: `const db = await connect("file.db")`, then `await db.exec(sql)`, `db.prepare(sql)` with `await stmt.run(...)/get(...)/all(...)`. Repository implementations must be async end-to-end (our interfaces should return Promises anyway).
- Named parameters use the `@name` prefix and are passed as a plain object; `run()` returns `{ changes, lastInsertRowid }`.
- Transactions via `exec("BEGIN") … exec("COMMIT"/"ROLLBACK")` work correctly (rollback verified). A better-sqlite3-style `db.transaction()` helper was not tested.
- **`PRAGMA foreign_keys` defaults to 0 (OFF).** `PRAGMA foreign_keys = ON` works and orphan inserts are then rejected. ⚠️ The Phase 2 composition root / connection factory must set this on every connection.
- **`journal_mode` defaults to `wal`** — expect `-wal`/`-shm` sidecar files next to the `.db`; the backup strategy (Phase 6) must account for them. `.gitignore` already covers them.
- Errors surface as typed `SqliteError` with a `code`, and constraint names appear in messages (CHECK / UNIQUE / FOREIGN KEY all distinguishable).

## Unsupported SQLite features encountered

None in the scope of this spike. Everything attempted worked, including `json_extract`, `strftime`, `ALTER TABLE ADD COLUMN`, and `CREATE INDEX`.

## Risk notes for Phase 2

- Package is **pre-1.0 (0.6.1)** — the Repository Pattern (AGENTS.md §4.1) remains the containment strategy; only `db/repositories/turso/` may import it.
- The spike's nested `deno.json` keeps this dependency out of the app; Phase 2 will add it to the root manifest (per AGENTS.md §8, flagging now: that is a dependency addition requiring approval).
- Concurrency behavior (multiple connections, busy timeouts) was not exercised; evaluate during Phase 2 repository tests.
