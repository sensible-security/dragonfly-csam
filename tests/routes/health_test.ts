// Health-check route tests (PLAN C2). Exercises the handler's connectivity
// probe through the repository layer: a live DB answers 200; a DB that has
// gone away answers a structured 503 (AGENTS.md §4.3). checkHealth is called
// directly so no Fresh app boot is required.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createContainer } from "@/db/container.ts";
import { checkHealth } from "@/routes/api/health.ts";

async function withTempDir(
  fn: (dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-health-" });
  try {
    await fn(join(dir, "test.db"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("checkHealth returns 200 { status: ok } on a live DB", async () => {
  await withTempDir(async (dbPath) => {
    const container = await createContainer({ dbPath });
    try {
      const res = await checkHealth(container.repositories);
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { status: "ok" });
    } finally {
      await container.close();
    }
  });
});

Deno.test("checkHealth returns a structured 503 when the DB is unreachable", async () => {
  await withTempDir(async (dbPath) => {
    const container = await createContainer({ dbPath });
    // Close the connection out from under the repositories to simulate a DB
    // that has become unreachable; the probe read must then fail.
    await container.close();

    const res = await checkHealth(container.repositories);
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error.code, "db_unavailable");
    assertEquals(typeof body.error.message, "string");
  });
});
