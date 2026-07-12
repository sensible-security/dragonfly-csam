// Inline status badge (docs/beercss-conventions.md §3/§4): `badge none` flows
// with text instead of corner-positioning, colored by MD3 *role* helpers only.
// The label always accompanies the color — color is never the sole indicator
// (§5 accessibility floor).
import type {
  AssetStatus,
  SoftwareAuthorizationStatus,
  SupportStatus,
} from "../db/repositories/interfaces/mod.ts";

export type BadgeTone = "positive" | "negative" | "caution" | "neutral";

// The project-standard semantic mapping (conventions §3) — do not improvise
// per-feature alternatives.
const TONE_CLASS: Record<BadgeTone, string> = {
  positive: "tertiary-container",
  negative: "error-container",
  caution: "secondary-container",
  neutral: "surface-variant",
};

export function assetStatusTone(status: AssetStatus): BadgeTone {
  switch (status) {
    case "authorized":
      return "positive";
    case "unauthorized":
    case "quarantined":
      return "negative";
    case "pending_review":
      return "caution";
    case "decommissioned":
      return "neutral";
  }
}

export function authorizationTone(
  status: SoftwareAuthorizationStatus,
): BadgeTone {
  switch (status) {
    case "authorized":
      return "positive";
    case "unauthorized":
      return "negative";
    case "exception_documented":
      return "caution";
  }
}

export function supportTone(status: SupportStatus): BadgeTone {
  switch (status) {
    case "supported":
      return "positive";
    case "unsupported":
      return "negative";
    case "eol_flagged":
      return "caution";
  }
}

export function StatusBadge(
  { label, tone }: { label: string; tone: BadgeTone },
) {
  return (
    <div class={`badge none ${TONE_CLASS[tone]}`}>
      {label.replaceAll("_", " ")}
    </div>
  );
}
