// Single-asset create via the manual connector + reconciliation (routes PRD
// Gate Q1, §4.1). The handler never writes canonical tables: the body becomes
// a manual Observation, IngestionService stages + reconciles it, and the
// response reports the *outcome* — created, auto_merged into an existing
// asset, or queued for human review. Validation happens inside the pipeline
// (the connector's Zod normalize step); a quarantined row surfaces as a
// structured 400 with its field/code issues.
import type { Repositories, Services } from "../../db/container.ts";
import type { AuditContext } from "../../db/repositories/interfaces/mod.ts";
import { errorResponse, toErrorResponse } from "./errors.ts";

export interface CreateDeps {
  repositories: Repositories;
  services: Services;
}

export interface CreateAssetResult {
  outcome: "created" | "auto_merged" | "queued";
  entityId?: string; // created / auto_merged
  reviewItemId?: string; // queued
  batchId: string;
}

const MANUAL_SOURCE_NAME = "manual";

export async function createAsset(
  deps: CreateDeps,
  kind: "device" | "software",
  body: unknown,
  ctx: AuditContext,
): Promise<Response> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(400, "validation_error", "body must be a JSON object");
  }

  // A stable externalId lets us find the staged record (and thus the
  // reconciliation outcome) after the pipeline run.
  const supplied = (body as Record<string, unknown>).externalId;
  const externalId = typeof supplied === "string" && supplied.length > 0
    ? supplied
    : crypto.randomUUID();
  // kind is fixed by the endpoint — a body cannot flip the entity type.
  const payload = { ...body, kind, externalId };

  try {
    const result = await deps.services.ingestion.ingest({
      sourceType: "manual",
      sourceName: MANUAL_SOURCE_NAME,
      payload,
    }, ctx);

    if (result.quarantined.length > 0) {
      return errorResponse(
        400,
        "validation_error",
        "observation failed validation",
        result.quarantined.flatMap((row) => row.issues),
      );
    }

    const source = await deps.repositories.sourceRecords.getSourceByName(
      MANUAL_SOURCE_NAME,
    );
    const record = source
      ? await deps.repositories.sourceRecords.findByExternalId(
        source.id,
        externalId,
      )
      : null;
    if (!record) {
      return errorResponse(
        500,
        "internal_error",
        "staged record not found after ingest",
      );
    }

    const base = { batchId: result.batchId };
    switch (record.reconciliationStatus) {
      case "created":
        return Response.json(
          {
            ...base,
            outcome: "created",
            entityId: record.matchedEntityId ?? undefined,
          } satisfies CreateAssetResult,
          { status: 201 },
        );
      case "auto_merged":
        return Response.json(
          {
            ...base,
            outcome: "auto_merged",
            entityId: record.matchedEntityId ?? undefined,
          } satisfies CreateAssetResult,
        );
      case "in_review": {
        const item = await deps.repositories.reviewQueue.findBySourceRecord(
          record.id,
        );
        return Response.json(
          {
            ...base,
            outcome: "queued",
            reviewItemId: item?.id,
          } satisfies CreateAssetResult,
        );
      }
      default:
        return errorResponse(
          500,
          "internal_error",
          `unexpected reconciliation status: ${record.reconciliationStatus}`,
        );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
