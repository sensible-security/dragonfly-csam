// Zod schemas for the canonical observation shapes (PRD §3). normalize() runs
// untrusted input through these: valid → a typed Observation, invalid → a
// RowError. Free-text is sanitized (control chars stripped, length-bounded) and
// stored as DATA — never interpreted (AGENTS.md §2.7). MAC addresses normalize
// to uppercase colon form, matching the canonical stored form.
import { z } from "zod";
import {
  ASSET_STATUSES,
  CRITICALITIES,
  DEVICE_CLASSES,
  END_USER_DEVICE_SUBTYPES,
  ENTERPRISE_ASSET_TYPES,
  ENVIRONMENTS,
  SOFTWARE_ASSET_TYPES,
  SOFTWARE_AUTHORIZATION_STATUSES,
  SOFTWARE_COMPONENT_TYPES,
  SUPPORT_STATUSES,
} from "../db/repositories/interfaces/mod.ts";
import type {
  DeviceObservation,
  Observation,
  RowError,
  SoftwareObservation,
} from "./types.ts";

const MAX_TEXT = 10_000;
const MAX_SHORT = 512;

// Strip C0/C1 control characters (keep tab 0x09, LF 0x0A, CR 0x0D); an ingested
// value can carry instruction-like text — this makes it inert data. Written as
// a codepoint filter so no literal control byte appears in the source.
function sanitize(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    const isControl = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) ||
      c === 0x7f;
    if (!isControl) out += ch;
  }
  return out;
}

const text = (max: number) => z.string().max(max).transform(sanitize);
const shortText = text(MAX_SHORT);
const longText = text(MAX_TEXT);

// MAC → uppercase colon-separated; rejects anything not 12 hex nibbles.
export const macAddressSchema = z.string().transform((raw, ctx) => {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `not a valid MAC address: ${raw}`,
    });
    return z.NEVER;
  }
  return hex.match(/.{2}/g)!.join(":");
});

const isoDate = z.string().min(1).max(MAX_SHORT);

// --- Field sets (all optional; a source supplies what it knows) -------------

const deviceFieldsSchema = z.object({
  deviceClass: z.enum(DEVICE_CLASSES).optional(),
  enterpriseAssetType: z.enum(ENTERPRISE_ASSET_TYPES).nullish(),
  endUserDeviceSubtype: z.enum(END_USER_DEVICE_SUBTYPES).nullish(),
  environment: z.enum(ENVIRONMENTS).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  hostname: shortText.optional(),
  domain: shortText.nullish(),
  hardwareSerial: shortText.nullish(),
  cloudInstanceId: shortText.nullish(),
  owner: shortText.optional(),
  department: shortText.optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  businessImpact: longText.optional(),
  notes: longText.nullish(),
}).strict();

const softwareFieldsSchema = z.object({
  softwareType: z.enum(SOFTWARE_ASSET_TYPES).optional(),
  componentType: z.enum(SOFTWARE_COMPONENT_TYPES).nullish(),
  authorizationStatus: z.enum(SOFTWARE_AUTHORIZATION_STATUSES).optional(),
  supportStatus: z.enum(SUPPORT_STATUSES).optional(),
  eolDate: shortText.nullish(),
  businessPurpose: longText.optional(),
  url: shortText.nullish(),
  deploymentMechanism: shortText.nullish(),
  licenseCount: z.number().int().nonnegative().nullish(),
  cpe: shortText.nullish(),
  decommissionDate: shortText.nullish(),
  criticality: z.enum(CRITICALITIES).optional(),
  businessImpact: longText.optional(),
}).strict();

const deviceMatchKeysSchema = z.object({
  cloudInstanceId: shortText.optional(),
  hardwareSerial: shortText.optional(),
  macAddresses: z.array(macAddressSchema).optional(),
  hostname: shortText.optional(),
  domain: shortText.optional(),
}).strict();

const observedInterfaceSchema = z.object({
  macAddress: macAddressSchema,
  interfaceName: shortText.nullish(),
  ips: z.array(z.object({
    address: shortText,
    observedAt: isoDate,
  })).optional(),
}).strict();

export const deviceObservationSchema = z.object({
  kind: z.literal("device"),
  externalId: shortText,
  observedAt: isoDate,
  matchKeys: deviceMatchKeysSchema,
  fields: deviceFieldsSchema,
  interfaces: z.array(observedInterfaceSchema).optional(),
}).strict();

export const softwareObservationSchema = z.object({
  kind: z.literal("software"),
  externalId: shortText,
  observedAt: isoDate,
  identity: z.object({
    title: shortText,
    publisher: shortText,
    version: shortText,
  }).strict(),
  fields: softwareFieldsSchema,
  installedOnExternalId: shortText.optional(),
}).strict();

export const observationSchema = z.discriminatedUnion("kind", [
  deviceObservationSchema,
  softwareObservationSchema,
]);

// Scanner-JSON push envelope (PRD §9.3). Observations are validated per-row by
// the connector's normalize(); the envelope only frames the batch.
export const scannerEnvelopeSchema = z.object({
  batchRef: shortText.optional(),
  observedAt: isoDate.optional(),
  observations: z.array(z.record(z.string(), z.unknown())).min(1),
}).strict();

// Compile-time guards: the schema outputs must be assignable to the TS shapes.
const _dCheck = (
  o: z.infer<typeof deviceObservationSchema>,
): DeviceObservation => o;
const _sCheck = (
  o: z.infer<typeof softwareObservationSchema>,
): SoftwareObservation => o;
void _dCheck;
void _sCheck;

// Maps a ZodError to the safe RowError shape (path + code + message only; the
// offending value is never echoed back as instruction text — AGENTS.md §2.7).
export function toRowError(
  rowRef: string | number,
  externalId: string | undefined,
  error: z.ZodError,
): RowError {
  return {
    rowRef,
    externalId,
    issues: error.issues.map((i) => ({
      field: i.path.join(".") || "(root)",
      code: i.code,
      message: i.message,
    })),
  };
}

// Runs a candidate object through the observation schema, returning a typed
// Observation or a RowError. Used by connectors whose raw payload is already
// object-shaped (manual, scanner); CSV builds its candidate first.
export function normalizeObservation(
  candidate: unknown,
  rowRef: string | number,
  externalId?: string,
): { ok: true; observation: Observation } | { ok: false; error: RowError } {
  const parsed = observationSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: toRowError(rowRef, externalId, parsed.error) };
  }
  return { ok: true, observation: parsed.data as Observation };
}
