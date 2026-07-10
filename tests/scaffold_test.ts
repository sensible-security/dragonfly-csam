import { assert } from "@std/assert";

// Guards the Beer CSS vendoring step (docs/beercss-conventions.md §1):
// the app shell links these files from static/, so a missing vendor
// directory would break every page while all TypeScript still compiles.
Deno.test("Beer CSS assets are vendored into static/", async () => {
  const base = new URL("../static/vendor/beercss/", import.meta.url);
  for (
    const file of [
      "beer.min.css",
      "beer.min.js",
      "material-symbols-outlined.woff2",
    ]
  ) {
    const stat = await Deno.stat(new URL(file, base));
    assert(stat.isFile, `${file} should be vendored`);
  }
});
