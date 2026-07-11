// CSV bulk-import connector (PRD §9.2). receive() parses the upload with the
// run's column mapping (ctx.options.columnMapping: header → canonical target)
// and emits one RawRecord per data row; the verbatim cells + mapping travel in
// the payload so normalize() stays pure and total. normalize() builds a device
// observation and Zod-validates it: unmapped-but-needed / bad enum / no usable
// match key → RowError (quarantined). Valid rows stage + reconcile.
//
// providesRequiredFields is true — CSV *can* carry criticality + business_impact
// (auto-create) — but reconciliation only auto-creates when a given row actually
// supplies them; otherwise the row becomes a review item (PRD §9.2, Assumption 1).
import type {
  Connector,
  ConnectorContext,
  DeviceObservation,
  NormalizationResult,
  RawRecord,
} from "../types.ts";
import { normalizeObservation } from "../schemas.ts";
import { parseCsv } from "./parse.ts";

export const CSV_SOURCE_TYPE = "csv_import" as const;
export const CSV_PRECEDENCE = 40;

// Canonical column-mapping targets. A mapping value outside this set is ignored
// (surfaced as an unmapped column, not a crash).
const MATCH_KEY_TARGETS = new Set([
  "cloudInstanceId",
  "hardwareSerial",
  "macAddress",
  "hostname",
  "domain",
]);
const DEVICE_FIELD_TARGETS = new Set([
  "deviceClass",
  "enterpriseAssetType",
  "endUserDeviceSubtype",
  "environment",
  "status",
  "owner",
  "department",
  "criticality",
  "businessImpact",
  "notes",
]);

interface CsvRecordPayload {
  cells: Record<string, string>; // verbatim row content
  mapping: Record<string, string>; // header → canonical target
  observedAt: string;
  externalId: string;
}

function readMapping(ctx: ConnectorContext): Record<string, string> {
  const raw = ctx.options?.columnMapping;
  if (raw && typeof raw === "object") return raw as Record<string, string>;
  return {};
}

function deriveExternalId(
  cells: Record<string, string>,
  mapping: Record<string, string>,
  lineNumber: number,
): string {
  // Prefer an explicit externalId column, then serial, then hostname, then the
  // row number — so duplicate-serial rows dedupe at staging.
  const byTarget = (target: string): string | undefined => {
    for (const [header, t] of Object.entries(mapping)) {
      if (t === target && cells[header]?.trim()) return cells[header].trim();
    }
    return undefined;
  };
  return byTarget("externalId") ?? byTarget("hardwareSerial") ??
    byTarget("hostname") ?? `row-${lineNumber}`;
}

function buildCandidate(p: CsvRecordPayload): DeviceObservation {
  const matchKeys: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  const interfaces: { macAddress: string }[] = [];

  for (const [header, target] of Object.entries(p.mapping)) {
    const value = p.cells[header];
    if (value === undefined || value.trim() === "") continue;
    const v = value.trim();
    if (target === "macAddress") {
      matchKeys.macAddresses = [v];
      interfaces.push({ macAddress: v });
    } else if (target === "hostname" || target === "domain") {
      matchKeys[target] = v;
      fields[target] = v;
    } else if (MATCH_KEY_TARGETS.has(target)) {
      matchKeys[target] = v;
      fields[target] = v;
    } else if (DEVICE_FIELD_TARGETS.has(target)) {
      fields[target] = v;
    }
    // externalId + unknown targets: handled elsewhere / ignored.
  }

  const candidate: DeviceObservation = {
    kind: "device",
    externalId: p.externalId,
    observedAt: p.observedAt,
    matchKeys: matchKeys as DeviceObservation["matchKeys"],
    fields: fields as DeviceObservation["fields"],
  };
  if (interfaces.length > 0) candidate.interfaces = interfaces;
  return candidate;
}

function hasMatchKey(c: DeviceObservation): boolean {
  const m = c.matchKeys;
  return Boolean(
    m.cloudInstanceId || m.hardwareSerial ||
      (m.macAddresses && m.macAddresses.length > 0) || m.hostname,
  );
}

export function createCsvConnector(id = "csv_import"): Connector {
  return {
    id,
    sourceType: CSV_SOURCE_TYPE,
    capabilities: {
      mode: "push",
      entityKinds: ["device"],
      matchKeys: ["hardware_serial", "mac_address", "hostname_domain"],
      providesRequiredFields: true,
      incremental: false,
    },

    receive(payload: unknown, ctx: ConnectorContext): RawRecord[] {
      const text = typeof payload === "string"
        ? payload
        : (payload && typeof payload === "object" &&
            typeof (payload as { text?: unknown }).text === "string"
          ? (payload as { text: string }).text
          : "");
      const mapping = readMapping(ctx);
      const { rows } = parseCsv(text);
      return rows.map((row) => {
        const externalId = deriveExternalId(row.cells, mapping, row.lineNumber);
        const record: CsvRecordPayload = {
          cells: row.cells,
          mapping,
          observedAt: ctx.observedAt,
          externalId,
        };
        return {
          externalId,
          payload: JSON.stringify(record),
          rowRef: row.lineNumber,
        };
      });
    },

    normalize(raw: RawRecord): NormalizationResult {
      let p: CsvRecordPayload;
      try {
        p = JSON.parse(raw.payload) as CsvRecordPayload;
      } catch {
        return {
          ok: false,
          error: {
            rowRef: raw.rowRef ?? 0,
            externalId: raw.externalId,
            issues: [{
              field: "(root)",
              code: "invalid_json",
              message: "row payload is not valid JSON",
            }],
          },
        };
      }
      const candidate = buildCandidate(p);
      if (!hasMatchKey(candidate)) {
        return {
          ok: false,
          error: {
            rowRef: raw.rowRef ?? 0,
            externalId: raw.externalId,
            issues: [{
              field: "matchKeys",
              code: "no_match_key",
              message: "row has no usable match key (serial, MAC, or hostname)",
            }],
          },
        };
      }
      return normalizeObservation(candidate, raw.rowRef ?? 0, raw.externalId);
    },
  };
}
