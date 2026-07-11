// Manual-entry connector (PRD §9.1). One UI form submission / API call = one
// RawRecord. The input is already structured (the Phase-4 form / API builds an
// Observation-shaped object); normalize only validates it. Manual entry is
// authoritative — source precedence 100, and reconciliation treats its fields
// as manual overrides (immune to automated overwrite). providesRequiredFields
// is true, so a full submission can auto-create a canonical asset.
import type {
  Connector,
  ConnectorContext,
  NormalizationResult,
  RawRecord,
} from "./types.ts";
import { normalizeObservation } from "./schemas.ts";

export const MANUAL_SOURCE_TYPE = "manual" as const;
export const MANUAL_PRECEDENCE = 100;

export function createManualConnector(id = "manual"): Connector {
  return {
    id,
    sourceType: MANUAL_SOURCE_TYPE,
    capabilities: {
      mode: "push",
      entityKinds: ["device", "software"],
      matchKeys: [
        "cloud_instance_id",
        "hardware_serial",
        "mac_address",
        "hostname_domain",
        "software_identity",
      ],
      providesRequiredFields: true,
      incremental: false,
    },

    receive(payload: unknown, ctx: ConnectorContext): RawRecord[] {
      const obj: Record<string, unknown> =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? { ...(payload as Record<string, unknown>) }
          : {};
      if (obj.observedAt === undefined) obj.observedAt = ctx.observedAt;
      const externalId =
        typeof obj.externalId === "string" && obj.externalId.length > 0
          ? obj.externalId
          : crypto.randomUUID();
      obj.externalId = externalId;
      return [{ externalId, payload: JSON.stringify(obj), rowRef: 0 }];
    },

    normalize(raw: RawRecord): NormalizationResult {
      let candidate: unknown;
      try {
        candidate = JSON.parse(raw.payload);
      } catch {
        return {
          ok: false,
          error: {
            rowRef: raw.rowRef ?? 0,
            externalId: raw.externalId,
            issues: [{
              field: "(root)",
              code: "invalid_json",
              message: "payload is not valid JSON",
            }],
          },
        };
      }
      return normalizeObservation(candidate, raw.rowRef ?? 0, raw.externalId);
    },
  };
}
