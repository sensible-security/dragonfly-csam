// Shared query-string boundary for list routes (routes PRD §3). Every list
// endpoint — API and server-rendered UI alike — parses its URLSearchParams
// here: Zod-validated against the taxonomy enums, unknown params rejected,
// pagination clamped. Pure boundary code: imports domain interface types only
// (the `(_shared)` segment is ignored by the Fresh fs router).
import { z } from "zod";
import {
  ASSET_STATUSES,
  AUDIT_ACTIONS,
  CRITICALITIES,
  DEVICE_CLASSES,
  ENTERPRISE_ASSET_TYPES,
  ENVIRONMENTS,
  PROVENANCE_ENTITY_TYPES,
  REVIEW_CONFIDENCES,
  REVIEW_REASONS,
  REVIEW_STATUSES,
  SOFTWARE_ASSET_TYPES,
  SOFTWARE_AUTHORIZATION_STATUSES,
  SUPPORT_STATUSES,
} from "../../db/repositories/interfaces/mod.ts";
import type {
  AuditFilter,
  DeviceFilter,
  PageRequest,
  ReviewQueueFilter,
  ReviewQueueSort,
  SoftwareFilter,
} from "../../db/repositories/interfaces/mod.ts";

// Field/code/message only — never the offending value (AGENTS.md §2.7:
// untrusted input is not echoed back as instruction-like text).
export interface QueryIssue {
  field: string;
  code: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: QueryIssue[] };

export interface ListQuery<F> {
  filter: F;
  page: PageRequest;
}

const PAGE_DEFAULT_LIMIT = 50;
const PAGE_MAX_LIMIT = 200;

// GET forms submit every field; empty string means "not filtered".
const optionalTrimmed = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

function optionalEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(values).optional(),
  );
}

const paginationShape = {
  limit: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : Number(v)),
    z.number().int().optional(),
  ),
  offset: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : Number(v)),
    z.number().int().optional(),
  ),
};

const deviceListSchema = z.object({
  status: optionalEnum(ASSET_STATUSES),
  deviceClass: optionalEnum(DEVICE_CLASSES),
  enterpriseAssetType: optionalEnum(ENTERPRISE_ASSET_TYPES),
  environment: optionalEnum(ENVIRONMENTS),
  criticality: optionalEnum(CRITICALITIES),
  department: optionalTrimmed,
  hostname: optionalTrimmed,
  ...paginationShape,
}).strict();

const softwareListSchema = z.object({
  softwareType: optionalEnum(SOFTWARE_ASSET_TYPES),
  authorizationStatus: optionalEnum(SOFTWARE_AUTHORIZATION_STATUSES),
  supportStatus: optionalEnum(SUPPORT_STATUSES),
  criticality: optionalEnum(CRITICALITIES),
  eolBefore: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").optional(),
  ),
  title: optionalTrimmed,
  ...paginationShape,
}).strict();

// Zod's default messages echo the received value/keys — untrusted input must
// not round-trip into responses (AGENTS.md §2.7), so rebuild safe messages
// from our own vocabulary only.
function safeMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case "invalid_enum_value":
      return `expected one of: ${issue.options.join(", ")}`;
    case "unrecognized_keys":
      return "unrecognized query parameter";
    case "invalid_type":
      return `expected ${issue.expected}`;
    default:
      return issue.message;
  }
}

// Exported for the body schemas too — one sanitization policy per boundary.
export function zodIssues(error: z.ZodError): QueryIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(query)",
    code: issue.code,
    message: safeMessage(issue),
  }));
}

function clampPage(limit?: number, offset?: number): PageRequest {
  return {
    limit: Math.min(Math.max(limit ?? PAGE_DEFAULT_LIMIT, 1), PAGE_MAX_LIMIT),
    offset: Math.max(offset ?? 0, 0),
  };
}

function parseWith<S extends z.ZodTypeAny, F>(
  schema: S,
  search: URLSearchParams,
  toFilter: (parsed: z.infer<S>) => F,
): ParseResult<ListQuery<F>> {
  const raw: Record<string, string> = {};
  for (const [key, value] of search.entries()) raw[key] = value;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };

  return {
    ok: true,
    value: {
      filter: toFilter(parsed.data),
      page: clampPage(parsed.data.limit, parsed.data.offset),
    },
  };
}

export function parseDeviceListQuery(
  search: URLSearchParams,
): ParseResult<ListQuery<DeviceFilter>> {
  return parseWith(deviceListSchema, search, (q): DeviceFilter => ({
    ...(q.status !== undefined && { status: q.status }),
    ...(q.deviceClass !== undefined && { deviceClass: q.deviceClass }),
    ...(q.enterpriseAssetType !== undefined &&
      { enterpriseAssetType: q.enterpriseAssetType }),
    ...(q.environment !== undefined && { environment: q.environment }),
    ...(q.criticality !== undefined && { criticality: q.criticality }),
    ...(q.department !== undefined && { department: q.department }),
    ...(q.hostname !== undefined && { hostnameContains: q.hostname }),
  }));
}

export function parseSoftwareListQuery(
  search: URLSearchParams,
): ParseResult<ListQuery<SoftwareFilter>> {
  return parseWith(softwareListSchema, search, (q): SoftwareFilter => ({
    ...(q.softwareType !== undefined && { softwareType: q.softwareType }),
    ...(q.authorizationStatus !== undefined &&
      { authorizationStatus: q.authorizationStatus }),
    ...(q.supportStatus !== undefined && { supportStatus: q.supportStatus }),
    ...(q.criticality !== undefined && { criticality: q.criticality }),
    ...(q.eolBefore !== undefined && { eolBefore: q.eolBefore }),
    ...(q.title !== undefined && { titleContains: q.title }),
  }));
}

// Review queue (routes PRD §4.4): filter + sort + paginate. `attr` filters a
// projected attribute as "field:value"; sortBy may be a top-level column or a
// projected attribute name.
const reviewQueueListSchema = z.object({
  status: optionalEnum(REVIEW_STATUSES),
  entityKind: optionalEnum(PROVENANCE_ENTITY_TYPES),
  reason: optionalEnum(REVIEW_REASONS),
  confidence: optionalEnum(REVIEW_CONFIDENCES),
  sourceId: optionalTrimmed,
  attr: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^[^:]+:.+$/, "expected field:value").optional(),
  ),
  sortBy: optionalTrimmed,
  sortDir: optionalEnum(["asc", "desc"] as const),
  ...paginationShape,
}).strict();

export interface ReviewQueueQuery {
  filter: ReviewQueueFilter;
  sort: ReviewQueueSort;
  page: PageRequest;
}

export function parseReviewQueueQuery(
  search: URLSearchParams,
): ParseResult<ReviewQueueQuery> {
  const raw: Record<string, string> = {};
  for (const [key, value] of search.entries()) raw[key] = value;

  const parsed = reviewQueueListSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const q = parsed.data;

  let attributeContains: ReviewQueueFilter["attributeContains"];
  if (q.attr !== undefined) {
    const idx = q.attr.indexOf(":");
    attributeContains = {
      field: q.attr.slice(0, idx),
      value: q.attr.slice(idx + 1),
    };
  }

  return {
    ok: true,
    value: {
      filter: {
        ...(q.status !== undefined && { status: q.status }),
        ...(q.entityKind !== undefined && { entityKind: q.entityKind }),
        ...(q.reason !== undefined && { reason: q.reason }),
        ...(q.confidence !== undefined && { confidence: q.confidence }),
        ...(q.sourceId !== undefined && { sourceId: q.sourceId }),
        ...(attributeContains !== undefined && { attributeContains }),
      },
      sort: { by: q.sortBy ?? "createdAt", dir: q.sortDir ?? "desc" },
      page: clampPage(q.limit, q.offset),
    },
  };
}

// Audit log (routes PRD §4.5): read-only query + paginate.
const auditListSchema = z.object({
  entityType: optionalTrimmed,
  entityId: optionalTrimmed,
  actorId: optionalTrimmed,
  action: optionalEnum(AUDIT_ACTIONS),
  occurredAfter: optionalTrimmed,
  occurredBefore: optionalTrimmed,
  ...paginationShape,
}).strict();

export function parseAuditListQuery(
  search: URLSearchParams,
): ParseResult<ListQuery<AuditFilter>> {
  return parseWith(auditListSchema, search, (q): AuditFilter => ({
    ...(q.entityType !== undefined && { entityType: q.entityType }),
    ...(q.entityId !== undefined && { entityId: q.entityId }),
    ...(q.actorId !== undefined && { actorId: q.actorId }),
    ...(q.action !== undefined && { action: q.action }),
    ...(q.occurredAfter !== undefined && { occurredAfter: q.occurredAfter }),
    ...(q.occurredBefore !== undefined && { occurredBefore: q.occurredBefore }),
  }));
}

// Rebuilds a query string from the current params with overrides applied —
// pagination prev/next links and filter-preserving navigation (PRD §5:
// filtered views are shareable URLs). Empty values are dropped.
export function queryString(
  search: URLSearchParams,
  overrides: Record<string, string> = {},
): string {
  const next = new URLSearchParams();
  for (const [key, value] of search.entries()) {
    if (value !== "") next.set(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") next.delete(key);
    else next.set(key, value);
  }
  return next.toString();
}
