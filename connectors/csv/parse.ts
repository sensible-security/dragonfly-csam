// Minimal, dependency-free CSV parser (AGENTS.md §11.3: prefer a no-dep line
// parser over adding a dependency). Handles RFC-4180 quoting: double-quoted
// fields, embedded commas/newlines, and "" escapes. Untrusted input — it only
// splits text into cells; it never interprets any value.

export interface CsvRow {
  lineNumber: number; // 1-based data-row number (header excluded)
  raw: string; // the verbatim source line(s) for this record
  cells: Record<string, string>; // header → verbatim cell value
}

export interface ParsedCsv {
  header: string[];
  rows: CsvRow[];
}

interface Field {
  value: string;
}

// Tokenizes the whole document into records (arrays of fields), tracking the
// verbatim slice for each record so the raw payload can be preserved.
function tokenize(text: string): { fields: string[]; raw: string }[] {
  const records: { fields: string[]; raw: string }[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let recordStart = 0;
  let i = 0;

  const pushField = () => {
    fields.push(field);
    field = "";
  };
  const pushRecord = (end: number) => {
    pushField();
    records.push({ fields, raw: text.slice(recordStart, end) });
    fields = [];
    recordStart = end + 1;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      pushRecord(i);
      i += 2;
      recordStart = i;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      pushRecord(i);
      i++;
      recordStart = i;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing record (no final newline), unless the document ended exactly on a
  // record boundary (field empty and no fields accumulated).
  if (field !== "" || fields.length > 0) {
    pushField();
    records.push({ fields, raw: text.slice(recordStart) });
  }
  return records;
}

export function parseCsv(text: string): ParsedCsv {
  const records = tokenize(text).filter((r) =>
    // Drop fully-blank lines (a single empty field and empty raw).
    !(r.fields.length === 1 && r.fields[0] === "" && r.raw.trim() === "")
  );
  if (records.length === 0) return { header: [], rows: [] };

  const header = records[0].fields.map((h) => h.trim());
  const rows: CsvRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const cells: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      cells[header[c]] = rec.fields[c] ?? "";
    }
    rows.push({ lineNumber: r, raw: rec.raw, cells });
  }
  return { header, rows };
}

export type { Field };
