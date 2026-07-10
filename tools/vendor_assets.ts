/**
 * Vendors the pinned Beer CSS distribution into static/vendor/beercss/ so the
 * app has no runtime CDN dependency (docs/beercss-conventions.md §1).
 *
 * The whole dist/cdn directory is mirrored because beer.min.css references
 * sibling files (Material Symbols .woff2 fonts, shape .svg masks) by relative
 * URL.
 *
 * Run via: deno task assets:vendor
 * Re-run only when the version pin below changes; commit the results.
 */

const VERSION = "4.0.23"; // pinned — keep in sync with docs/beercss-conventions.md
const LIST_URL = `https://data.jsdelivr.com/v1/packages/npm/beercss@${VERSION}`;
const CDN_BASE = `https://cdn.jsdelivr.net/npm/beercss@${VERSION}/dist/cdn/`;
const DEST = new URL("../static/vendor/beercss/", import.meta.url);

interface JsdelivrEntry {
  type: "file" | "directory";
  name: string;
  files?: JsdelivrEntry[];
}

function collect(entries: JsdelivrEntry[], prefix: string): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    if (entry.type === "directory") {
      paths.push(...collect(entry.files ?? [], `${path}/`));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

const listing = await fetch(LIST_URL);
if (!listing.ok) {
  throw new Error(`jsdelivr listing failed: HTTP ${listing.status}`);
}
const pkg = (await listing.json()) as { files: JsdelivrEntry[] };
const cdnFiles = collect(pkg.files, "")
  .filter((p) => p.startsWith("dist/cdn/"))
  .map((p) => p.slice("dist/cdn/".length));

if (cdnFiles.length === 0) {
  throw new Error("no dist/cdn files found in package listing");
}

await Deno.mkdir(DEST, { recursive: true });

console.log(`Vendoring beercss@${VERSION} (${cdnFiles.length} files) ...`);
for (const file of cdnFiles) {
  const res = await fetch(`${CDN_BASE}${file}`);
  if (!res.ok) {
    throw new Error(`download failed for ${file}: HTTP ${res.status}`);
  }
  await Deno.writeFile(
    new URL(file, DEST),
    new Uint8Array(await res.arrayBuffer()),
  );
  console.log(`  ${file}`);
}

await Deno.writeTextFile(
  new URL("VERSION", DEST),
  `beercss@${VERSION} (dist/cdn mirror, vendored by tools/vendor_assets.ts)\n`,
);
console.log("Done.");
