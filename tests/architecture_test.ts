// Architecture-boundary test (PLAN C3; Phase 2 gate). Makes the Repository
// Pattern a permanent regression test instead of a one-time grep: no file in
// the outer layers may import the Turso driver or anything under
// db/repositories/turso/, and none may embed SQL. db/container.ts is the sole
// sanctioned importer of the driver and lives outside these scanned dirs.
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

// Layers that must depend on interfaces only (AGENTS.md §4.1).
const SCANNED_DIRS = [
  "routes",
  "services",
  "islands",
  "components",
  "db/repositories/interfaces",
];

// Any module specifier reaching the driver or the concrete SQL layer.
const FORBIDDEN_IMPORT = /@tursodatabase\/|repositories\/turso\//;

// Module specifiers in import/export-from and dynamic import() forms.
const SPECIFIER_PATTERNS = [
  /(?:import|export)\b[\s\S]*?from\s*["']([^"']+)["']/g,
  /import\s*\(\s*["']([^"']+)["']/g,
];

// Hand-written SQL that must never appear outside db/repositories/turso/.
const SQL_PATTERNS = [
  /\bSELECT\b[\s\S]{0,400}?\bFROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+TABLE\b/i,
  /\bPRAGMA\b/i,
];

async function* walkTs(dir: string): AsyncGenerator<string> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return; // empty layer, e.g. services/
    throw error;
  }
  for await (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTs(path);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      yield path;
    }
  }
}

function forbiddenImports(source: string): string[] {
  const hits: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (FORBIDDEN_IMPORT.test(match[1])) hits.push(match[1]);
    }
  }
  return hits;
}

Deno.test("outer layers never import the Turso driver or SQL layer", async () => {
  const violations: string[] = [];
  for (const rel of SCANNED_DIRS) {
    for await (const path of walkTs(`${ROOT}${rel}`)) {
      const source = await Deno.readTextFile(path);
      for (const specifier of forbiddenImports(source)) {
        violations.push(`${path} imports "${specifier}"`);
      }
    }
  }
  assertEquals(
    violations,
    [],
    `forbidden imports found:\n${violations.join("\n")}`,
  );
});

Deno.test("outer layers contain no embedded SQL", async () => {
  const violations: string[] = [];
  for (const rel of SCANNED_DIRS) {
    for await (const path of walkTs(`${ROOT}${rel}`)) {
      const source = await Deno.readTextFile(path);
      if (SQL_PATTERNS.some((p) => p.test(source))) {
        violations.push(path);
      }
    }
  }
  assertEquals(violations, [], `SQL found in:\n${violations.join("\n")}`);
});
