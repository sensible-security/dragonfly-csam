import { connect } from "@tursodatabase/database";
try { await Deno.remove("fk.db"); } catch { /* ok */ }
const db = await connect("fk.db");
await db.exec("PRAGMA foreign_keys = ON");
console.log("pragma set:", await db.prepare("PRAGMA foreign_keys").all());
await db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
await db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))");
try {
  await db.exec("INSERT INTO child (pid) VALUES (999)");
  console.log("FK violation NOT enforced (insert succeeded)");
} catch (e) {
  console.log("FK violation enforced:", (e as Error).message);
}
db.close();
