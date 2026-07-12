# Deploying Dragonfly CSAM

Dragonfly ships as a **single Deno container** with an **embedded Turso database**
(the Rust `tursodatabase/turso` rewrite — an in-process, local `.db` file, not
libSQL or Turso Cloud). There is no separate database server, no network database
connection, and no sidecar. All persistent state is one SQLite-format file (plus
its WAL sidecars) living on a mounted volume. The container is disposable; the
volume is the system of record.

- **Runtime:** Deno 2.9.x on the `denoland/deno` base image, non-root `deno` user.
- **Web:** Deno Fresh 2.x, served by `deno serve` on port **8000**.
- **Database:** `@tursodatabase/database` opening `/app/data/dragonfly.db`.
- **Migrations:** forward-only SQL in `db/migrations/`, applied automatically on boot.

---

## 1. Prerequisites

- Docker Engine 24+ and Docker Compose v2.
- Nothing else — the image is self-contained (the Turso native addon is fetched
  at build time via npm `optionalDependencies`; no network DB, no `--allow-net`
  to any external host at runtime).

---

## 2. Configuration

All configuration is via environment variables (never baked into the image).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DRAGONFLY_DB_PATH` | no | `/app/data/dragonfly.db` | Embedded DB file path. Keep it inside the mounted volume. |
| `DRAGONFLY_ADMIN_USERNAME` | first boot | — | Seeds the initial `admin` account **only while the users table is empty**. |
| `DRAGONFLY_ADMIN_PASSWORD` | first boot | — | Password for the seed admin. **Must be ≥ 12 characters** or seeding is skipped. |
| `DRAGONFLY_COOKIE_SECURE` | no | `0` | Set `1` behind a TLS-terminating proxy so session cookies get the `Secure` flag. |
| `DRAGONFLY_SESSION_TTL_HOURS` | no | `8` | Session lifetime in hours. |

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
# edit .env — set a strong admin username/password
```

`.env` is gitignored. Never commit real credentials or inventory data
(AGENTS.md §8).

### First-boot admin seeding

On startup the app calls `bootstrapAdminFromEnv()`. It creates the first admin
**only if no users exist yet**. Once any user exists, the variables are ignored,
so they are safe to leave in `.env`. If they are unset (or the password is too
short) on an empty database, the app logs a warning and starts with **no one
able to sign in** — set them before the first launch.

---

## 3. Build and run

```bash
docker compose up -d --build
```

This builds the image, creates the `dragonfly-data` volume, applies migrations
on boot, seeds the admin, and starts serving on <http://localhost:8000>.

Check status and logs:

```bash
docker compose ps          # STATUS should read "healthy" after ~15s
docker compose logs -f app
```

The container has a built-in healthcheck that polls `/api/health` (which
verifies DB connectivity through the repository layer). `docker compose ps`
surfaces the result.

To put a TLS terminator (nginx/Caddy/Traefik/cloud LB) in front, proxy to the
container's port 8000 and set `DRAGONFLY_COOKIE_SECURE=1` in `.env`.

### Permission model

The container runs `deno serve` with the **minimal** permission set the embedded
database needs (per `spikes/turso/FINDINGS.md`) — not a blanket `-A`:

| Flag | Why |
|---|---|
| `--allow-ffi` | Turso client is a napi native addon (`.node` binary). |
| `--allow-read` | Load the addon from `node_modules/`, read `_fresh/`, static assets, and the `.db` file. |
| `--allow-write` | Write the `.db`, `.db-wal`, and `.db-shm` files. |
| `--allow-env` | Read `DRAGONFLY_*` configuration. |
| `--allow-net` | Bind the HTTP listener on `0.0.0.0:8000`. There is **no** outbound DB network access. |

---

## 4. Persistence and the data volume

The DB file and its WAL sidecars live in the `dragonfly-data` named volume mounted
at `/app/data`:

```
/app/data/dragonfly.db        # main database
/app/data/dragonfly.db-wal    # write-ahead log (journal_mode=wal)
/app/data/dragonfly.db-shm    # shared-memory index
```

The image pre-creates `/app/data` owned by the `deno` user, so a **fresh named
volume** inherits writable ownership automatically.

> **Bind mounts:** if you mount a host directory instead of a named volume, Docker
> preserves the host directory's ownership, which the non-root `deno` user (uid
> 1000) usually cannot write. Fix it once on the host:
> `sudo chown -R 1000:1000 /path/to/host/data`.

Migrations run automatically on every boot and are forward-only and idempotent
(already-applied migrations are skipped), so restarting or upgrading the image
against an existing volume is safe. To apply migrations manually against the
volume without starting the web server:

```bash
docker compose run --rm app deno task db:migrate
```

---

## 5. Backup and restore

The database is a single file, but it runs in **WAL mode**, so at any instant the
newest committed data may live in `dragonfly.db-wal` rather than `dragonfly.db`.
A naive copy of only `dragonfly.db` while the app is running can miss recent
writes or capture a torn state. Two correct strategies:

### 5a. Cold backup (recommended — guaranteed consistent)

Stop the container so the WAL is checkpointed and the files are quiescent, copy
the whole data directory, then restart:

```bash
docker compose stop app
docker run --rm \
  -v dragonfly-csam_dragonfly-data:/data:ro \
  -v "$(pwd)/backups:/backup" \
  denoland/deno:2.9.2 \
  sh -c "cp -a /data/. /backup/dragonfly-$(date +%Y%m%d-%H%M%S)/"
docker compose start app
```

(Volume name is `<project>_dragonfly-data`; confirm with `docker volume ls`.)
This copies `dragonfly.db` **and** its `-wal`/`-shm` sidecars together, which is
the only way to guarantee a hot copy is consistent — so always back up the three
files as a set, never the `.db` alone.

Automate it with cron on the host, e.g. nightly:

```cron
0 2 * * *  cd /opt/dragonfly && docker compose stop app && \
  docker run --rm -v dragonfly-csam_dragonfly-data:/data:ro -v /opt/dragonfly/backups:/backup \
  denoland/deno:2.9.2 sh -c 'cp -a /data/. /backup/dragonfly-$(date +\%Y\%m\%d)/' && \
  docker compose start app
```

The container restart is brief (seconds). For zero-downtime needs, front the
service with a second replica or accept the short maintenance window; a
guaranteed-consistent backup is worth more than avoiding a few seconds of
downtime for an inventory system.

### 5b. Retention and off-host copies

- Keep backups **off the Docker host** — a volume backup on the same disk does
  not survive host loss. Sync `backups/` to object storage or another machine.
- The DB is **Sensitive Data** (AGENTS.md §8): encrypt backups at rest and
  restrict access the same way you would the live inventory.
- Suggested retention: 7 daily + 4 weekly + 12 monthly, tuned to your RPO.

### 5c. Restore

```bash
docker compose down                      # stop the app (keeps the volume)
# Recreate/clear the volume, then load the backup into it:
docker run --rm \
  -v dragonfly-csam_dragonfly-data:/data \
  -v "$(pwd)/backups/dragonfly-YYYYMMDD-HHMMSS:/backup:ro" \
  denoland/deno:2.9.2 \
  sh -c "rm -f /data/dragonfly.db* && cp -a /backup/. /data/"
docker compose up -d
```

Restore all three files (`.db`, `-wal`, `-shm`) if present. After start, confirm
health (`docker compose ps`) and spot-check the inventory and audit log.

---

## 6. Health, monitoring, and logs

- **Health:** `GET /api/health` returns `200 {"status":"ok"}` when the DB is
  reachable, `503 {"error":{"code":"db_unavailable"}}` otherwise. It is an open
  route (no auth) and is wired into the container healthcheck.
- **Logs:** the app logs to stdout/stderr; use `docker compose logs` or ship them
  to your aggregator. No PII or secrets are logged (AGENTS.md §8) — do not add
  any.
- **Audit trail:** every asset/status/connector mutation writes an audit record
  (viewable at `/audit-log`); this is the application-level activity record,
  distinct from container logs.

---

## 7. Upgrades and rollback

**Upgrade:**

```bash
git pull
docker compose up -d --build          # rebuild image; migrations apply on boot
docker compose ps                     # confirm "healthy"
```

Because migrations are forward-only and idempotent, the new image reconciles the
existing volume automatically.

**Rollback:** redeploy the previous image tag / git revision:

```bash
git checkout <previous-tag>
docker compose up -d --build
```

> Forward-only migrations have **no automatic down-migration**. If an upgrade
> introduced a schema change that a rollback image cannot read, restore the
> pre-upgrade backup (§5c). **Always take a cold backup before upgrading.**

---

## 8. Pre-launch checklist

- [ ] `.env` created with a strong admin password (≥ 12 chars); real secrets not committed.
- [ ] `DRAGONFLY_COOKIE_SECURE=1` set if served over HTTPS / behind a TLS proxy.
- [ ] `deno task check` and `deno task test` green on the shipped revision.
- [ ] `docker compose up -d --build` succeeds; `docker compose ps` shows `healthy`.
- [ ] `/api/health` returns 200; a manual sign-in with the seeded admin works.
- [ ] Volume backup job scheduled and a **test restore** verified.
- [ ] Cold backup taken immediately before any subsequent upgrade.
