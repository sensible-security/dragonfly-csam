// CsvImportUploader (Prompt 4.3c). Upload → column-map → import → per-row
// error report, driving POST /api/import/csv (the analyst upload path —
// distinct from the API-key machine ingest endpoints). Headers and cell
// values from the file are untrusted DATA: rendered as inert text only, and
// the server-side pipeline revalidates every row regardless of the mapping
// chosen here.
import { useState } from "preact/hooks";

// Canonical column-mapping targets (mirrors the CSV connector's vocabulary;
// the connector ignores anything else). "" = ignore this column.
const TARGETS = [
  "",
  "externalId",
  "hostname",
  "domain",
  "hardwareSerial",
  "macAddress",
  "cloudInstanceId",
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
] as const;

interface ImportResult {
  batchId: string;
  received: number;
  staged: number;
  quarantined: {
    rowRef: string | number;
    externalId?: string;
    issues: { field: string; code: string; message: string }[];
  }[];
  reconciliation: {
    autoMerged: number;
    queuedForReview: number;
    created: number;
  };
}

// Minimal quoted-aware split for the header line only; data rows are parsed
// server-side by the connector.
function parseHeaderLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  out.push(current.trim());
  return out.filter((h) => h !== "");
}

function guessTarget(header: string): string {
  const normalized = header.toLowerCase().replaceAll(/[^a-z]/g, "");
  const hit = TARGETS.find((t) => t !== "" && t.toLowerCase() === normalized);
  return hit ?? "";
}

export default function CsvImportUploader() {
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sourceName, setSourceName] = useState("csv-upload");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const headerLine = text.split(/\r?\n/, 1)[0] ?? "";
    const parsed = parseHeaderLine(headerLine);
    setCsvText(text);
    setFileName(file.name);
    setHeaders(parsed);
    setMapping(Object.fromEntries(parsed.map((h) => [h, guessTarget(h)])));
    setResult(null);
    setError(null);
  }

  async function submit() {
    if (!csvText) return;
    const columnMapping = Object.fromEntries(
      Object.entries(mapping).filter(([, target]) => target !== ""),
    );
    if (Object.keys(columnMapping).length === 0) {
      setError("map at least one column");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/import/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csvText, columnMapping, sourceName }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          (body as { error?: { message?: string } } | null)?.error?.message ??
            `import failed (HTTP ${res.status})`,
        );
      } else {
        setResult(body as ImportResult);
      }
    } catch {
      setError("network error — nothing was imported");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div class="field label border">
        <input type="file" accept=".csv,text/csv" onChange={onFile} />
        <label>CSV file</label>
      </div>

      {headers.length > 0 && (
        <>
          <p class="small-text">
            {fileName}: map each column to a canonical field (unmapped columns
            are ignored).
          </p>
          <div class="grid">
            {headers.map((header) => (
              <div class="field label border small s12 m6 l4">
                <select
                  value={mapping[header] ?? ""}
                  onChange={(e) =>
                    setMapping({
                      ...mapping,
                      [header]: (e.target as HTMLSelectElement).value,
                    })}
                >
                  {TARGETS.map((target) => (
                    <option
                      value={target}
                      selected={target === (mapping[header] ?? "")}
                    >
                      {target === "" ? "(ignore)" : target}
                    </option>
                  ))}
                </select>
                <label>{header}</label>
              </div>
            ))}
          </div>

          <div class="grid">
            <div class="field label border s12 m6">
              <input
                type="text"
                placeholder=" "
                value={sourceName}
                onInput={(e) =>
                  setSourceName((e.target as HTMLInputElement).value)}
              />
              <label>Source name</label>
            </div>
            <nav class="s12 m6">
              <button
                type="button"
                disabled={busy || sourceName === ""}
                onClick={submit}
              >
                <i>upload</i>
                <span>{busy ? "Importing…" : "Import"}</span>
              </button>
            </nav>
          </div>
        </>
      )}

      {error && <p class="error-text" role="alert">{error}</p>}

      {result && (
        <article class="border round">
          <h6>Import result</h6>
          <p>
            {result.received} rows received — {result.staged} staged,{" "}
            {result.quarantined.length} quarantined. Reconciliation:{" "}
            {result.reconciliation.autoMerged} merged,{" "}
            {result.reconciliation.created} created,{" "}
            {result.reconciliation.queuedForReview} queued for review.
          </p>
          {result.quarantined.length > 0 && (
            <>
              <table class="border stripes scroll">
                <caption class="left-align">
                  Per-row errors (quarantined rows never reach the inventory)
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Field</th>
                    <th scope="col">Code</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {result.quarantined.flatMap((row) =>
                    row.issues.map((issue) => (
                      <tr>
                        <td>{row.rowRef}</td>
                        <td>{issue.field}</td>
                        <td>{issue.code}</td>
                        <td>{issue.message}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <nav>
                <a
                  class="button border"
                  href={`/api/ingestion-batches/${result.batchId}/errors`}
                >
                  <i>download</i>
                  <span>Download error report</span>
                </a>
              </nav>
            </>
          )}
          <nav>
            <button
              type="button"
              class="border"
              onClick={() => location.reload()}
            >
              Refresh batches
            </button>
          </nav>
        </article>
      )}
    </div>
  );
}
