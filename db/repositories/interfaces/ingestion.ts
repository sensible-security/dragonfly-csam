// Ingestion-pipeline domain contracts (PRD-ingestion-pipeline §5–§8). Pure
// TypeScript — no driver, no SQL. The `as const` enum arrays are the single
// source of truth for the CHECK lists in db/migrations/0002_ingestion.sql
// (enforced by the ingestion enum-parity test).
import type { AuditContext, Page, PageRequest } from "./common.ts";
import type { ProvenanceEntityType } from "./taxonomy.ts";

// ---------------------------------------------------------------------------
// Persisted enums (parity-tested against 0002_ingestion.sql).
// ---------------------------------------------------------------------------

// Connector taxonomy — pins sources.source_type (core-PRD gate decision 3).
export const SOURCE_TYPES = [
  "manual",
  "csv_import",
  "scanner_json",
  "dhcp_log",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

// Per-staged-record reconciliation outcome (source_records.reconciliation_status).
export const RECONCILIATION_STATUSES = [
  "pending",
  "auto_merged",
  "in_review",
  "created",
  "rejected",
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const BATCH_STATUSES = [
  "running",
  "completed",
  "failed",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const REVIEW_REASONS = [
  "ambiguous_match",
  "conflicting_field",
  "new_asset",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_CONFIDENCES = [
  "high",
  "medium",
  "ambiguous",
] as const;
export type ReviewConfidence = (typeof REVIEW_CONFIDENCES)[number];

export const REVIEW_STATUSES = [
  "pending",
  "merged",
  "rejected",
  "created_new",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// Reconciliation match keys (PRD §6.1). Not persisted as a column — recorded
// inside candidates_json — but a fixed vocabulary the engine and UI share.
export const MATCH_KEY_NAMES = [
  "cloud_instance_id",
  "hardware_serial",
  "mac_address",
  "hostname_domain",
  "software_identity",
] as const;
export type MatchKeyName = (typeof MATCH_KEY_NAMES)[number];

// ---------------------------------------------------------------------------
// ingestion_batches — one connector run = one batch (PRD §5, Assumption 6).
// ---------------------------------------------------------------------------
export interface IngestionBatch {
  id: string;
  sourceId: string;
  connectorId: string;
  status: BatchStatus;
  totalRows: number;
  stagedCount: number;
  quarantinedCount: number;
  actorType: AuditContext["actorType"];
  actorId: string;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface OpenIngestionBatch {
  sourceId: string;
  connectorId: string;
}

export interface FinalizeIngestionBatch {
  status: BatchStatus;
  totalRows: number;
  stagedCount: number;
  quarantinedCount: number;
}

// ---------------------------------------------------------------------------
// ingestion_errors — quarantined rows (PRD Assumption 4). raw_row is untrusted
// DATA stored verbatim; issues are Zod-derived, safe. Powers the CSV error
// report.
// ---------------------------------------------------------------------------
export interface RowIssue {
  field: string;
  code: string;
  message: string;
}

export interface IngestionError {
  id: string;
  batchId: string;
  rowRef: string;
  externalId: string | null;
  rawRow: string;
  issues: RowIssue[];
  createdAt: string;
}

export interface CreateIngestionError {
  batchId: string;
  rowRef: string;
  externalId?: string | null;
  rawRow: string;
  issues: RowIssue[];
}

export interface IIngestionBatchRepository {
  open(input: OpenIngestionBatch, ctx: AuditContext): Promise<IngestionBatch>;
  finalize(
    id: string,
    counts: FinalizeIngestionBatch,
    ctx: AuditContext,
  ): Promise<IngestionBatch>;
  getById(id: string): Promise<IngestionBatch | null>;
  recordError(input: CreateIngestionError): Promise<IngestionError>;
  listErrors(batchId: string): Promise<IngestionError[]>;
}

// ---------------------------------------------------------------------------
// review_queue — human resolution of ambiguity / new-asset enrichment (PRD §7).
// ---------------------------------------------------------------------------
export interface ReviewCandidate {
  entityId: string;
  matchedKey: MatchKeyName;
  score: number;
  conflicts: string[];
}

export interface ReviewQueueItem {
  id: string;
  sourceRecordId: string;
  entityKind: ProvenanceEntityType;
  reason: ReviewReason;
  confidence: ReviewConfidence;
  candidates: ReviewCandidate[];
  // Projected observation attributes for sort/filter/scan (PRD §7).
  attributes: Record<string, string | null>;
  status: ReviewStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface CreateReviewItem {
  sourceRecordId: string;
  entityKind: ProvenanceEntityType;
  reason: ReviewReason;
  confidence: ReviewConfidence;
  candidates: ReviewCandidate[];
  attributes: Record<string, string | null>;
}

export interface ReviewQueueFilter {
  status?: ReviewStatus; // repository defaults to "pending" when omitted
  entityKind?: ProvenanceEntityType;
  reason?: ReviewReason;
  confidence?: ReviewConfidence;
  sourceId?: string; // resolved through the item's source record
  attributeContains?: { field: string; value: string };
}

export interface ReviewQueueSort {
  // A projected attribute name, or a top-level column (createdAt, confidence…).
  by: string;
  dir: "asc" | "desc";
}

export interface ResolveReviewItem {
  status: Exclude<ReviewStatus, "pending">;
  resolvedBy: string;
}

export interface IReviewQueueRepository {
  enqueue(
    input: CreateReviewItem,
    ctx: AuditContext,
  ): Promise<ReviewQueueItem>;
  getById(id: string): Promise<ReviewQueueItem | null>;
  list(
    filter: ReviewQueueFilter,
    sort: ReviewQueueSort,
    page: PageRequest,
  ): Promise<Page<ReviewQueueItem>>;
  // Closes an item; writes a status_change audit entry.
  resolve(
    id: string,
    resolution: ResolveReviewItem,
    ctx: AuditContext,
  ): Promise<ReviewQueueItem>;
}
