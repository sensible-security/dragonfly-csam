// Throwaway probe: what does @tursodatabase/database actually export?
import * as mod from "@tursodatabase/database";

console.log("exports:", Object.keys(mod));
for (const [key, value] of Object.entries(mod)) {
  console.log(`  ${key}: ${typeof value}`);
}
