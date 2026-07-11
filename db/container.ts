// Composition root (AGENTS.md §4.1; PLAN Slice C / DEVELOPMENT_PLAN Prompt 2.3).
//
// This is the ONE sanctioned place outside db/repositories/turso/ that imports
// the Turso driver and concrete repositories. It opens a single connection,
// applies migrations on boot, constructs each repository exactly once, and
// hands callers a bundle typed purely by the repository *interfaces*. Route
// handlers and services resolve this bundle from Fresh app state — they never
// see the driver, the SQL, or the concrete classes. The architecture-boundary
// test (tests/architecture_test.ts) enforces that this stays the only importer.
import { openDatabase } from "./repositories/turso/connection.ts";
import { migrate } from "./repositories/turso/migrator.ts";
import { TursoAuditLogRepository } from "./repositories/turso/audit_log_repository.ts";
import { TursoDeviceRepository } from "./repositories/turso/device_repository.ts";
import { TursoServiceProviderRepository } from "./repositories/turso/service_provider_repository.ts";
import { TursoSoftwareRepository } from "./repositories/turso/software_repository.ts";
import { TursoSourceRecordRepository } from "./repositories/turso/source_record_repository.ts";
import type {
  IAuditLogRepository,
  IDeviceRepository,
  IServiceProviderRepository,
  ISoftwareRepository,
  ISourceRecordRepository,
} from "./repositories/interfaces/mod.ts";

// The typed bundle exposed via Fresh app state. Interface types only — no
// driver, no concrete class, no SQL leaks past this boundary.
export interface Repositories {
  readonly devices: IDeviceRepository;
  readonly software: ISoftwareRepository;
  readonly serviceProviders: IServiceProviderRepository;
  readonly auditLog: IAuditLogRepository;
  readonly sourceRecords: ISourceRecordRepository;
}

export interface Container {
  readonly repositories: Repositories;
  // Closes the underlying connection. Used by tests and graceful shutdown.
  close(): Promise<void>;
}

export interface ContainerOptions {
  // Defaults to $DRAGONFLY_DB_PATH, then "data/dragonfly.db". Never hardcoded
  // at a call site so tests can point at a temp file.
  dbPath?: string;
  // Apply pending migrations before opening the long-lived connection.
  // Default true (migrations-on-boot); tests that pre-migrate can opt out.
  applyMigrations?: boolean;
}

const DEFAULT_DB_PATH = "data/dragonfly.db";

function resolveDbPath(dbPath?: string): string {
  return dbPath ?? Deno.env.get("DRAGONFLY_DB_PATH") ?? DEFAULT_DB_PATH;
}

// Builds a fresh, independent container. Each call opens its own connection and
// constructs its own repository set. Prefer getContainer() for the running app
// (single instance per process); use this directly in tests for isolation.
export async function createContainer(
  options: ContainerOptions = {},
): Promise<Container> {
  const dbPath = resolveDbPath(options.dbPath);

  if (options.applyMigrations ?? true) {
    await migrate(dbPath);
  }

  const db = await openDatabase(dbPath);

  const repositories: Repositories = {
    devices: new TursoDeviceRepository(db),
    software: new TursoSoftwareRepository(db),
    serviceProviders: new TursoServiceProviderRepository(db),
    auditLog: new TursoAuditLogRepository(db),
    sourceRecords: new TursoSourceRecordRepository(db),
  };

  return {
    repositories,
    close: () => db.close(),
  };
}

// Process-wide singleton for the running app. Constructed lazily on first call
// and memoized, so the whole process shares one connection and one repository
// set (PLAN C1: "constructed exactly once per process"). The in-flight promise
// is cached so concurrent first callers cannot race two connections open.
let containerPromise: Promise<Container> | undefined;

export function getContainer(): Promise<Container> {
  if (containerPromise === undefined) {
    containerPromise = createContainer();
  }
  return containerPromise;
}
