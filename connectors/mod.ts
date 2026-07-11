// Connector framework barrel. Pure layer — no SQL/driver imports (boundary
// test scans this directory). A new connector is registered here; no service
// edits are needed (open/closed, PRD §4).
export * from "./types.ts";
export * from "./registry.ts";
export {
  deviceObservationSchema,
  macAddressSchema,
  normalizeObservation,
  observationSchema,
  scannerEnvelopeSchema,
  softwareObservationSchema,
  toRowError,
} from "./schemas.ts";
export { createManualConnector, MANUAL_PRECEDENCE } from "./manual.ts";
export { createCsvConnector, CSV_PRECEDENCE } from "./csv/mod.ts";
export {
  createScannerJsonConnector,
  InvalidEnvelopeError,
  SCANNER_JSON_PRECEDENCE,
} from "./scanner_json.ts";

import type { SourceType } from "./types.ts";
import { ConnectorRegistry } from "./registry.ts";
import { createManualConnector, MANUAL_PRECEDENCE } from "./manual.ts";
import { createCsvConnector, CSV_PRECEDENCE } from "./csv/mod.ts";
import {
  createScannerJsonConnector,
  SCANNER_JSON_PRECEDENCE,
} from "./scanner_json.ts";

// Default field-precedence ranks per source type (PRD §6.3, gate decision 2).
// Higher wins on a merge conflict. dhcp_log (20) is design-for (not built).
export const DEFAULT_PRECEDENCE: Record<SourceType, number> = {
  manual: MANUAL_PRECEDENCE,
  scanner_json: SCANNER_JSON_PRECEDENCE,
  csv_import: CSV_PRECEDENCE,
  dhcp_log: 20,
};

// The registry the running app uses: the three Phase-3 connectors, each mapped
// 1:1 to its source type. Fresh registry per call so tests stay isolated.
export function createDefaultRegistry(): ConnectorRegistry {
  return new ConnectorRegistry()
    .register(createManualConnector())
    .register(createCsvConnector())
    .register(createScannerJsonConnector());
}
