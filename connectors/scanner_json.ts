// Scanner-JSON ingest connector (PRD §9.3; Safeguards 1.3, 1.5, 2.4). Push,
// machine-to-machine. The envelope frames a batch of observations; each
// observation is validated per-row by normalize (bad observation → quarantined
// RowError, not a rejected batch). An invalid ENVELOPE is a 400 — surfaced by
// InvalidEnvelopeError, which the ingest route maps to a structured 400.
// providesRequiredFields is false: scanners don't know business criticality, so
// a no-match becomes a review item, never a silent create (PRD Assumption 1).
import type {
  Connector,
  ConnectorContext,
  NormalizationResult,
  RawRecord,
  RowError,
} from "./types.ts";
import {
  normalizeObservation,
  scannerEnvelopeSchema,
  toRowError,
} from "./schemas.ts";

export const SCANNER_JSON_SOURCE_TYPE = "scanner_json" as const;
export const SCANNER_JSON_PRECEDENCE = 50;

// Thrown by receive() when the envelope itself is malformed (→ HTTP 400). Bad
// individual observations do NOT throw — they quarantine per-row.
export class InvalidEnvelopeError extends Error {
  constructor(readonly issues: RowError["issues"]) {
    super("scanner ingest envelope is invalid");
    this.name = "InvalidEnvelopeError";
  }
}

export function createScannerJsonConnector(id = "scanner_json"): Connector {
  return {
    id,
    sourceType: SCANNER_JSON_SOURCE_TYPE,
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
      providesRequiredFields: false,
      incremental: false,
    },

    receive(payload: unknown, ctx: ConnectorContext): RawRecord[] {
      const parsed = scannerEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        throw new InvalidEnvelopeError(
          toRowError("(envelope)", undefined, parsed.error).issues,
        );
      }
      const observedAt = parsed.data.observedAt ?? ctx.observedAt;
      return parsed.data.observations.map((obs, i) => {
        const o: Record<string, unknown> = { ...obs };
        if (o.observedAt === undefined) o.observedAt = observedAt;
        const externalId =
          typeof o.externalId === "string" && o.externalId.length > 0
            ? o.externalId
            : `obs-${i}`;
        o.externalId = externalId;
        return { externalId, payload: JSON.stringify(o), rowRef: i };
      });
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
              message: "observation is not valid JSON",
            }],
          },
        };
      }
      return normalizeObservation(candidate, raw.rowRef ?? 0, raw.externalId);
    },
  };
}
