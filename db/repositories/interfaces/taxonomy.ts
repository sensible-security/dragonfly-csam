// CIS v8.1 taxonomy enums (AGENTS.md §5 — exact values, no invention).
// Each `as const` array is the single TypeScript source of truth; the SQL
// CHECK constraints in db/migrations/0001_initial.sql must list identical
// values (enforced by the enum-parity test in tests/repositories/).

export const DEVICE_CLASSES = [
  "enterprise_asset",
  "removable_media",
] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const ENTERPRISE_ASSET_TYPES = [
  "end_user_device",
  "server",
  "network_device",
  "iot_noncomputing_device",
] as const;
export type EnterpriseAssetType = (typeof ENTERPRISE_ASSET_TYPES)[number];

// Ordered subtype: mobile is a subset of portable. "All portable devices"
// queries must match IN ('portable', 'mobile').
export const END_USER_DEVICE_SUBTYPES = [
  "desktop_workstation",
  "portable",
  "mobile",
] as const;
export type EndUserDeviceSubtype = (typeof END_USER_DEVICE_SUBTYPES)[number];

export const ENVIRONMENTS = [
  "physical",
  "virtual",
  "cloud",
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

// Safeguard 1.2 statuses plus lifecycle states.
export const ASSET_STATUSES = [
  "authorized",
  "unauthorized",
  "quarantined",
  "pending_review",
  "decommissioned",
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

// NIST CSF 2.0 ID.AM-05.
export const CRITICALITIES = [
  "low",
  "medium",
  "high",
  "mission_critical",
] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const SOFTWARE_ASSET_TYPES = [
  "application",
  "operating_system",
  "firmware",
] as const;
export type SoftwareAssetType = (typeof SOFTWARE_ASSET_TYPES)[number];

// Child of application/operating_system only — never firmware.
export const SOFTWARE_COMPONENT_TYPES = [
  "service",
  "library",
  "api",
] as const;
export type SoftwareComponentType = (typeof SOFTWARE_COMPONENT_TYPES)[number];

// Safeguard 2.3.
export const SOFTWARE_AUTHORIZATION_STATUSES = [
  "authorized",
  "unauthorized",
  "exception_documented",
] as const;
export type SoftwareAuthorizationStatus =
  (typeof SOFTWARE_AUTHORIZATION_STATUSES)[number];

// Safeguard 2.2.
export const SUPPORT_STATUSES = [
  "supported",
  "unsupported",
  "eol_flagged",
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

// Structural enums (not CIS taxonomy) — still CHECK-enforced so the audit
// trail and provenance stay queryable.

export const PROVENANCE_ENTITY_TYPES = [
  "device",
  "software",
] as const;
export type ProvenanceEntityType = (typeof PROVENANCE_ENTITY_TYPES)[number];

export const AUDIT_ACTOR_TYPES = [
  "user",
  "connector",
  "system",
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "status_change",
  "merge",
  "ingest",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
