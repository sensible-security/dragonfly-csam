// IngestionService — Normalize → Stage (PRD §5). One connector run = one batch:
// resolve/register the source, open a batch, gather raw records (receive/fetch),
// normalize each, stage valid observations, quarantine invalid rows, then hand
// off to reconciliation. Depends only on repository interfaces + the connector
// registry — no SQL/driver imports (architecture-boundary test).
import type {
  AuditContext,
  IIngestionBatchRepository,
  ISourceRecordRepository,
  RowIssue,
} from "../db/repositories/interfaces/mod.ts";
import {
  type ConnectorRegistry,
  DEFAULT_PRECEDENCE,
  type RawRecord,
  type RowError,
  type SourceType,
} from "../connectors/mod.ts";
import type {
  ReconciliationService,
  ReconciliationSummary,
} from "./reconciliation_service.ts";

export interface IngestRequest {
  sourceType: SourceType;
  sourceName: string; // resolves/creates the sources row
  payload?: unknown; // push connectors
  options?: Record<string, unknown>; // e.g. { columnMapping } for CSV
}

export interface IngestionBatchResult {
  batchId: string;
  received: number;
  staged: number;
  quarantined: RowError[]; // downloadable error-report source
  reconciliation: ReconciliationSummary;
}

export interface IngestionService {
  ingest(
    input: IngestRequest,
    ctx: AuditContext,
  ): Promise<IngestionBatchResult>;
}

export interface IngestionDeps {
  registry: ConnectorRegistry;
  sourceRecords: ISourceRecordRepository;
  batches: IIngestionBatchRepository;
  reconciliation: ReconciliationService;
}

const nowIso = () => new Date().toISOString();

export class DefaultIngestionService implements IngestionService {
  constructor(private readonly deps: IngestionDeps) {}

  async ingest(
    input: IngestRequest,
    ctx: AuditContext,
  ): Promise<IngestionBatchResult> {
    const connector = this.deps.registry.require(input.sourceType);

    // Resolve or register the source (idempotent by name). precedence is the
    // connector's default rank (PRD §6.3).
    const source =
      await this.deps.sourceRecords.getSourceByName(input.sourceName) ??
        await this.deps.sourceRecords.registerSource({
          sourceType: input.sourceType,
          name: input.sourceName,
          precedence: DEFAULT_PRECEDENCE[input.sourceType],
        }, ctx);

    const batch = await this.deps.batches.open(
      { sourceId: source.id, connectorId: connector.id },
      ctx,
    );

    const connectorCtx = {
      sourceId: source.id,
      observedAt: nowIso(),
      options: input.options,
    };

    const quarantined: RowError[] = [];
    let staged = 0;

    try {
      // Gather raw records: push connectors receive a payload; pull fetch.
      let raws: RawRecord[];
      if (connector.capabilities.mode === "push") {
        if (!connector.receive) {
          throw new Error(
            `connector ${connector.id} declares push but has no receive()`,
          );
        }
        raws = await connector.receive(input.payload, connectorCtx);
      } else {
        if (!connector.fetch) {
          throw new Error(
            `connector ${connector.id} declares pull but has no fetch()`,
          );
        }
        raws = await connector.fetch(connectorCtx);
      }

      for (const raw of raws) {
        const result = connector.normalize(raw);
        if (!result.ok) {
          quarantined.push(result.error);
          await this.deps.batches.recordError({
            batchId: batch.id,
            rowRef: String(result.error.rowRef),
            externalId: result.error.externalId ?? null,
            rawRow: raw.payload, // verbatim, untrusted DATA
            issues: result.error.issues as RowIssue[],
          });
          continue;
        }
        // Stage the valid observation with provenance (raw + normalized).
        await this.deps.sourceRecords.upsertObservation({
          sourceId: source.id,
          externalId: result.observation.externalId,
          entityKind: result.observation.kind,
          rawPayload: raw.payload,
          normalizedPayload: JSON.stringify(result.observation),
          observedAt: result.observation.observedAt,
        }, ctx);
        staged++;
      }

      await this.deps.batches.finalize(batch.id, {
        status: "completed",
        totalRows: raws.length,
        stagedCount: staged,
        quarantinedCount: quarantined.length,
      }, ctx);

      // Synchronous per-batch reconciliation (PRD Assumption 3): the caller
      // gets the full outcome summary before ingest() returns.
      const reconciliation = await this.deps.reconciliation.reconcileBatch(
        batch.id,
        ctx,
      );

      return {
        batchId: batch.id,
        received: raws.length,
        staged,
        quarantined,
        reconciliation,
      };
    } catch (err) {
      // A malformed envelope or a downstream failure marks the batch failed
      // rather than leaving it dangling as 'running'; the error propagates.
      await this.deps.batches.finalize(batch.id, {
        status: "failed",
        totalRows: staged + quarantined.length,
        stagedCount: staged,
        quarantinedCount: quarantined.length,
      }, ctx).catch(() => {});
      throw err;
    }
  }
}
