// Typed domain errors (PRD §3.5). Repositories translate driver constraint
// violations into these so no caller ever sees a driver error type.

export class NotFoundError extends Error {
  constructor(entityType: string, id: string) {
    super(`${entityType} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class TaxonomyViolationError extends Error {
  constructor(detail: string) {
    super(`taxonomy violation: ${detail}`);
    this.name = "TaxonomyViolationError";
  }
}

export class DuplicateAssetError extends Error {
  constructor(detail: string) {
    super(`duplicate asset: ${detail}`);
    this.name = "DuplicateAssetError";
  }
}

// NIST ID.AM-05: criticality and business_impact are required on all assets.
export class MissingCriticalityError extends Error {
  constructor(detail: string) {
    super(`criticality/business_impact required: ${detail}`);
    this.name = "MissingCriticalityError";
  }
}
