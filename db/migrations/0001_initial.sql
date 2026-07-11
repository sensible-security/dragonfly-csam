-- 0001_initial.sql — Dragonfly CSAM core schema
-- PRD: docs/specs/PRD-core-data-model.md §2 · Taxonomy: AGENTS.md §5 (exact)
-- Forward-only: never edit this file after it ships; extend by new migration.
-- Enum CHECK value lists must stay byte-identical to the arrays in
-- db/repositories/interfaces/taxonomy.ts (enum-parity test enforces this).

-- ---------------------------------------------------------------------------
-- devices — Safeguards 1.1, 1.2; ID.AM-01, -05
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  device_class TEXT NOT NULL
    CHECK (device_class IN ('enterprise_asset', 'removable_media')),
  enterprise_asset_type TEXT
    CHECK (enterprise_asset_type IN ('end_user_device', 'server', 'network_device', 'iot_noncomputing_device')),
  end_user_device_subtype TEXT
    CHECK (end_user_device_subtype IN ('desktop_workstation', 'portable', 'mobile')),
  environment TEXT NOT NULL
    CHECK (environment IN ('physical', 'virtual', 'cloud')),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('authorized', 'unauthorized', 'quarantined', 'pending_review', 'decommissioned')),
  hostname TEXT NOT NULL,
  domain TEXT,
  hardware_serial TEXT,
  cloud_instance_id TEXT,
  owner TEXT NOT NULL,
  department TEXT NOT NULL,
  criticality TEXT NOT NULL
    CHECK (criticality IN ('low', 'medium', 'high', 'mission_critical')),
  business_impact TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Hierarchy: enterprise assets must be typed; removable media must not be.
  CHECK (
    (device_class = 'enterprise_asset' AND enterprise_asset_type IS NOT NULL)
    OR (device_class = 'removable_media' AND enterprise_asset_type IS NULL)
  ),
  -- Hierarchy: subtype only on end-user devices.
  CHECK (
    end_user_device_subtype IS NULL
    OR enterprise_asset_type = 'end_user_device'
  )
);

-- Reconciliation match keys (Phase 3) + hot paths.
CREATE INDEX idx_devices_cloud_instance_id ON devices (cloud_instance_id);
CREATE INDEX idx_devices_hardware_serial ON devices (hardware_serial);
CREATE INDEX idx_devices_hostname_domain ON devices (hostname, domain);
CREATE INDEX idx_devices_status ON devices (status);
CREATE INDEX idx_devices_criticality ON devices (criticality);

-- ---------------------------------------------------------------------------
-- network_interfaces — Safeguard 1.1 (MAC is a match key, not globally unique)
-- ---------------------------------------------------------------------------
CREATE TABLE network_interfaces (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id),
  mac_address TEXT NOT NULL, -- normalized uppercase colon-separated
  interface_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, mac_address)
);

CREATE INDEX idx_network_interfaces_mac_address ON network_interfaces (mac_address);

-- ---------------------------------------------------------------------------
-- ip_assignments — Safeguard 1.1 (append-only IP history; IPs are dynamic)
-- ---------------------------------------------------------------------------
CREATE TABLE ip_assignments (
  id TEXT PRIMARY KEY,
  interface_id TEXT NOT NULL REFERENCES network_interfaces (id),
  ip_address TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE INDEX idx_ip_assignments_interface_last_seen ON ip_assignments (interface_id, last_seen);
CREATE INDEX idx_ip_assignments_ip_address ON ip_assignments (ip_address);

-- ---------------------------------------------------------------------------
-- software — Safeguards 2.1, 2.2, 2.3; ID.AM-02, -05
-- Version-level catalog entry: identity is (title, publisher, version).
-- ---------------------------------------------------------------------------
CREATE TABLE software (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL,
  version TEXT NOT NULL,
  software_type TEXT NOT NULL
    CHECK (software_type IN ('application', 'operating_system', 'firmware')),
  component_type TEXT
    CHECK (component_type IN ('service', 'library', 'api')),
  authorization_status TEXT NOT NULL DEFAULT 'unauthorized'
    CHECK (authorization_status IN ('authorized', 'unauthorized', 'exception_documented')),
  support_status TEXT NOT NULL DEFAULT 'supported'
    CHECK (support_status IN ('supported', 'unsupported', 'eol_flagged')),
  eol_date TEXT,
  business_purpose TEXT NOT NULL,
  url TEXT,
  deployment_mechanism TEXT,
  license_count INTEGER
    CHECK (license_count >= 0),
  cpe TEXT, -- Control 7 hook (CVE binding later)
  decommission_date TEXT,
  criticality TEXT NOT NULL
    CHECK (criticality IN ('low', 'medium', 'high', 'mission_critical')),
  business_impact TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (title, publisher, version),
  -- Hierarchy: component types are children of application/OS only.
  CHECK (
    component_type IS NULL
    OR software_type IN ('application', 'operating_system')
  )
);

CREATE INDEX idx_software_authorization_status ON software (authorization_status);
CREATE INDEX idx_software_support_status ON software (support_status);

-- ---------------------------------------------------------------------------
-- sources — provenance registry anchor (full Connector taxonomy is Phase 3;
-- source_type deliberately unconstrained until then — gate decision 3)
-- ---------------------------------------------------------------------------
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- device_software — Safeguard 2.1 installs; joins ID.AM-01 ↔ -02
-- ---------------------------------------------------------------------------
CREATE TABLE device_software (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id),
  software_id TEXT NOT NULL REFERENCES software (id),
  install_date TEXT,
  discovery_source_id TEXT REFERENCES sources (id),
  uninstalled_at TEXT, -- NULL = currently installed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, software_id)
);

-- ---------------------------------------------------------------------------
-- exceptions — Safeguards 2.2 / 2.3 documented-exception workflow
-- ---------------------------------------------------------------------------
CREATE TABLE exceptions (
  id TEXT PRIMARY KEY,
  software_id TEXT NOT NULL REFERENCES software (id),
  justification TEXT NOT NULL,
  approved_by TEXT NOT NULL, -- identity string until Phase 5 auth
  review_by TEXT NOT NULL,
  revoked_at TEXT, -- active exception ⇔ NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_exceptions_software_id ON exceptions (software_id);

-- ---------------------------------------------------------------------------
-- service_providers — ID.AM-04 (Control 15 groundwork)
-- ---------------------------------------------------------------------------
CREATE TABLE service_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  services_provided TEXT NOT NULL,
  data_classification_handled TEXT NOT NULL,
  contract_reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- source_records — staging with provenance (AGENTS.md §4.2). raw_payload is
-- untrusted DATA, stored verbatim, never interpreted.
-- ---------------------------------------------------------------------------
CREATE TABLE source_records (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources (id),
  external_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL
    CHECK (entity_kind IN ('device', 'software')),
  raw_payload TEXT NOT NULL,
  normalized_payload TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, external_id)
);

-- ---------------------------------------------------------------------------
-- field_provenance — which source currently owns each canonical field value.
-- entity_id is polymorphic (device/software); FK enforced in repository layer.
-- ---------------------------------------------------------------------------
CREATE TABLE field_provenance (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('device', 'software')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources (id),
  observed_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, field_name)
);

-- ---------------------------------------------------------------------------
-- audit_log — AGENTS.md §4.4; CIS Control 8 front-load. Append-only: the
-- repository contract exposes no update/delete. entity_type is an open set
-- (device, software, service_provider, source_record, exception, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL, -- UTC ISO-8601
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('user', 'connector', 'system')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('create', 'update', 'delete', 'status_change', 'merge', 'ingest')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT, -- NULL for create
  after_json TEXT, -- NULL for delete
  source_address TEXT
);

CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_log_occurred_at ON audit_log (occurred_at);
