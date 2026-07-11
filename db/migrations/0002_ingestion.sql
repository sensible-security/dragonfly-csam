-- 0002_ingestion.sql — Dragonfly CSAM ingestion pipeline schema (additive)
-- PRD: docs/specs/PRD-ingestion-pipeline.md §8 · Taxonomy: AGENTS.md §5, §4.2
-- Forward-only: 0001_initial.sql is frozen (AGENTS.md §8); all Phase 3 schema
-- change lands here. Enum CHECK value lists must stay byte-identical to the
-- arrays in db/repositories/interfaces/ingestion.ts (parity test enforces this).

-- ---------------------------------------------------------------------------
-- sources — add field-precedence rank (PRD Assumption 2) and finally pin the
-- source_type CHECK (core-PRD gate decision 3 deferred it to this migration).
-- SQLite cannot ALTER TABLE ADD CONSTRAINT, so the CHECK is added by the
-- standard 12-step table rebuild. There is no shipped production data, but the
-- rebuild copies any existing rows through regardless (rebuild-preserves test).
-- ---------------------------------------------------------------------------
ALTER TABLE sources ADD COLUMN precedence INTEGER NOT NULL DEFAULT 50;

CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('manual', 'csv_import', 'scanner_json', 'dhcp_log')),
  name TEXT NOT NULL UNIQUE,
  precedence INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO sources_new (id, source_type, name, precedence, created_at, updated_at)
  SELECT id, source_type, name, precedence, created_at, updated_at FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

-- ---------------------------------------------------------------------------
-- source_records — reconciliation linkage. Staged rows start 'pending';
-- reconciliation stamps the outcome + the canonical entity it resolved to.
-- ---------------------------------------------------------------------------
ALTER TABLE source_records ADD COLUMN reconciliation_status TEXT NOT NULL
  DEFAULT 'pending'
  CHECK (reconciliation_status IN ('pending', 'auto_merged', 'in_review', 'created', 'rejected'));
ALTER TABLE source_records ADD COLUMN matched_entity_type TEXT
  CHECK (matched_entity_type IN ('device', 'software'));
ALTER TABLE source_records ADD COLUMN matched_entity_id TEXT;
ALTER TABLE source_records ADD COLUMN reconciled_at TEXT;

CREATE INDEX idx_source_records_reconciliation_status
  ON source_records (reconciliation_status);

-- ---------------------------------------------------------------------------
-- ingestion_batches — one connector run = one batch (PRD §5, Assumption 6).
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_batches (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources (id),
  connector_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  staged_count INTEGER NOT NULL DEFAULT 0,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('user', 'connector', 'system')),
  actor_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ingestion_batches_source_id ON ingestion_batches (source_id);

-- ---------------------------------------------------------------------------
-- ingestion_errors — quarantined rows (PRD Assumption 4). raw_row is untrusted
-- DATA stored verbatim; issues_json is Zod-derived, safe error detail. Powers
-- the downloadable CSV error report.
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_errors (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches (id),
  row_ref TEXT NOT NULL,
  external_id TEXT,
  raw_row TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ingestion_errors_batch_id ON ingestion_errors (batch_id);

-- ---------------------------------------------------------------------------
-- review_queue — ambiguous matches + new-asset-needing-enrichment items land
-- here for a human (AGENTS.md §4.2: never auto-resolved). candidates_json is
-- the serialized candidate list; attributes_json projects sortable/filterable
-- observation fields (PRD §7, gate decision 1).
-- ---------------------------------------------------------------------------
CREATE TABLE review_queue (
  id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL REFERENCES source_records (id),
  entity_kind TEXT NOT NULL
    CHECK (entity_kind IN ('device', 'software')),
  reason TEXT NOT NULL
    CHECK (reason IN ('ambiguous_match', 'conflicting_field', 'new_asset')),
  confidence TEXT NOT NULL
    CHECK (confidence IN ('high', 'medium', 'ambiguous')),
  candidates_json TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'merged', 'rejected', 'created_new')),
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_review_queue_status ON review_queue (status);
CREATE INDEX idx_review_queue_source_record_id ON review_queue (source_record_id);
