// Structured-error contract (routes PRD §3): { error: { code, message,
// details? } }. toErrorResponse maps the typed domain errors to canonical
// codes/statuses; anything unrecognized becomes an opaque 500 so no driver
// message ever leaks past the boundary.
import {
  DuplicateAssetError,
  MissingCriticalityError,
  NotFoundError,
  TaxonomyViolationError,
} from "../../db/repositories/interfaces/mod.ts";
import type { QueryIssue } from "./query.ts";

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return Response.json(
    { error: { code, message, ...(details !== undefined && { details }) } },
    { status },
  );
}

// 400 for a rejected query/body; details carry field/code only, never the
// offending value (AGENTS.md §2.7).
export function validationErrorResponse(issues: QueryIssue[]): Response {
  return errorResponse(
    400,
    "validation_error",
    "request validation failed",
    issues,
  );
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof NotFoundError) {
    return errorResponse(404, "not_found", err.message);
  }
  // ReviewService's typed action errors (not exported as a class — matched by
  // name + code): a non-pending item is a 409 conflict; anything else (e.g.
  // missing_field on promotion) is a 422 with the service's code.
  if (
    err instanceof Error && err.name === "ReviewActionError" && "code" in err
  ) {
    const code = String((err as { code: unknown }).code);
    return code === "not_pending"
      ? errorResponse(409, "not_pending", err.message)
      : errorResponse(422, code, err.message);
  }
  if (err instanceof DuplicateAssetError) {
    return errorResponse(409, "conflict", err.message);
  }
  if (err instanceof TaxonomyViolationError) {
    return errorResponse(422, "taxonomy_violation", err.message);
  }
  if (err instanceof MissingCriticalityError) {
    return errorResponse(422, "missing_required_fields", err.message);
  }
  return errorResponse(500, "internal_error", "unexpected error");
}
