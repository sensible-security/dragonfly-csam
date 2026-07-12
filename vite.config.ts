import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";

export default defineConfig({
  plugins: [fresh()],
  // Keep the embedded Turso client out of the SSR bundle. Its native addon is
  // loaded through a package-internal `#index` import that resolves to a
  // platform-specific optional dependency (@tursodatabase/database-<target>).
  // Bundling inlines that resolution at the bundle's path and breaks it
  // (MODULE_NOT_FOUND at runtime). Left external, Deno resolves the package —
  // and its platform addon — through node_modules at runtime, as intended.
  ssr: {
    external: [
      "@tursodatabase/database",
      "@tursodatabase/database-common",
    ],
  },
  build: {
    rollupOptions: {
      external: [/^@tursodatabase\//],
    },
  },
});
