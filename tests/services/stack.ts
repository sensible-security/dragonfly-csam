// Shared full-stack builder for pipeline tests: real Turso repositories over a
// temp DB, the default connector registry, and both services wired the way the
// composition root wires them. Never shares state between tests.
import { join } from "@std/path";
import {
  type DatabaseConnection,
  openDatabase,
} from "@/db/repositories/turso/connection.ts";
import { migrate } from "@/db/repositories/turso/migrator.ts";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import { TursoDeviceRepository } from "@/db/repositories/turso/device_repository.ts";
import { TursoSoftwareRepository } from "@/db/repositories/turso/software_repository.ts";
import { TursoSourceRecordRepository } from "@/db/repositories/turso/source_record_repository.ts";
import { TursoIngestionBatchRepository } from "@/db/repositories/turso/ingestion_batch_repository.ts";
import { TursoReviewQueueRepository } from "@/db/repositories/turso/review_queue_repository.ts";
import {
  type ConnectorRegistry,
  createDefaultRegistry,
} from "@/connectors/mod.ts";
import { DefaultReconciliationService } from "@/services/reconciliation_service.ts";
import { DefaultIngestionService } from "@/services/ingestion_service.ts";
import { DefaultReviewService } from "@/services/review_service.ts";

export interface Stack {
  devices: TursoDeviceRepository;
  software: TursoSoftwareRepository;
  sourceRecords: TursoSourceRecordRepository;
  batches: TursoIngestionBatchRepository;
  reviewQueue: TursoReviewQueueRepository;
  auditLog: TursoAuditLogRepository;
  registry: ConnectorRegistry;
  ingestion: DefaultIngestionService;
  reconciliation: DefaultReconciliationService;
  review: DefaultReviewService;
}

export function buildStack(db: DatabaseConnection): Stack {
  const sourceRecords = new TursoSourceRecordRepository(db);
  const devices = new TursoDeviceRepository(db);
  const software = new TursoSoftwareRepository(db);
  const auditLog = new TursoAuditLogRepository(db);
  const batches = new TursoIngestionBatchRepository(db);
  const reviewQueue = new TursoReviewQueueRepository(db);
  const registry = createDefaultRegistry();
  const reconciliation = new DefaultReconciliationService({
    devices,
    software,
    sourceRecords,
    reviewQueue,
    auditLog,
    batches,
    registry,
  });
  const ingestion = new DefaultIngestionService({
    registry,
    sourceRecords,
    batches,
    reconciliation,
  });
  const review = new DefaultReviewService({
    devices,
    software,
    sourceRecords,
    reviewQueue,
    auditLog,
  });
  return {
    devices,
    software,
    sourceRecords,
    batches,
    reviewQueue,
    auditLog,
    registry,
    ingestion,
    reconciliation,
    review,
  };
}

export async function withStack(
  fn: (stack: Stack) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-pipeline-" });
  const dbPath = join(dir, "test.db");
  await migrate(dbPath);
  const db = await openDatabase(dbPath);
  try {
    await fn(buildStack(db));
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
}
