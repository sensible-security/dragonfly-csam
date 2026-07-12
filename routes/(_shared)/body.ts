// Request-body schemas for the write routes (routes PRD §3/§4). Strict Zod
// objects: unknown keys rejected, statuses excluded from PATCH bodies (they
// have dedicated audited routes), issues sanitized via zodIssues.
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
} from "../../db/repositories/interfaces/mod.ts";
import type {
  UpdateDevice,
  UpdateSoftware,
} from "../../db/repositories/interfaces/mod.ts";
import { type ParseResult, zodIssues } from "./query.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const updateDeviceSchema = z.object({
  deviceClass: z.enum(DEVICE_CLASSES).optional(),
  enterpriseAssetType: z.enum(ENTERPRISE_ASSET_TYPES).nullable().optional(),
  endUserDeviceSubtype: z.enum(END_USER_DEVICE_SUBTYPES).nullable().optional(),
  environment: z.enum(ENVIRONMENTS).optional(),
  hostname: z.string().min(1).optional(),
  domain: z.string().min(1).nullable().optional(),
  hardwareSerial: z.string().min(1).nullable().optional(),
  cloudInstanceId: z.string().min(1).nullable().optional(),
  owner: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  businessImpact: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
}).strict();

export const updateSoftwareSchema = z.object({
  title: z.string().min(1).optional(),
  publisher: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  softwareType: z.enum(SOFTWARE_ASSET_TYPES).optional(),
  componentType: z.enum(SOFTWARE_COMPONENT_TYPES).nullable().optional(),
  eolDate: isoDate.nullable().optional(),
  businessPurpose: z.string().min(1).optional(),
  url: z.string().min(1).nullable().optional(),
  deploymentMechanism: z.string().min(1).nullable().optional(),
  licenseCount: z.number().int().nonnegative().nullable().optional(),
  cpe: z.string().min(1).nullable().optional(),
  decommissionDate: isoDate.nullable().optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  businessImpact: z.string().min(1).optional(),
}).strict();

export const deviceStatusSchema = z.object({
  status: z.enum(ASSET_STATUSES),
}).strict();

export const softwareAuthorizationSchema = z.object({
  status: z.enum(SOFTWARE_AUTHORIZATION_STATUSES),
}).strict();

export const softwareSupportSchema = z.object({
  status: z.enum(SUPPORT_STATUSES),
}).strict();

// Review-queue action bodies (routes PRD §4.4).
export const mergeReviewSchema = z.object({
  targetEntityId: z.string().min(1),
}).strict();

// RequiredFields enrichment: what the source couldn't supply (review PRD §7).
export const requiredFieldsSchema = z.object({
  criticality: z.enum(CRITICALITIES),
  businessImpact: z.string().min(1),
  owner: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
}).strict();

export const rejectReviewSchema = z.object({
  reason: z.string().min(1),
}).strict();

export const bulkCreateNewSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1),
  enrichment: requiredFieldsSchema,
}).strict();

// CSV import (routes PRD §4.6).
export const csvImportSchema = z.object({
  csvText: z.string().min(1),
  columnMapping: z.record(z.string(), z.string().min(1)),
  sourceName: z.string().min(1),
}).strict();

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): ParseResult<z.infer<S>> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  return { ok: true, value: parsed.data };
}

export type { UpdateDevice, UpdateSoftware };
