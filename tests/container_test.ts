// Composition-root tests (PLAN C1). Verify the container wires real, working
// repositories against a temp DB, that DB path comes from config/env (never
// hardcoded), and that getContainer() constructs exactly one instance per
// process. Each createContainer() call gets its own temp file — no shared state.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { createContainer, getContainer } from "@/db/container.ts";
import type { AuditContext } from "@/db/repositories/interfaces/mod.ts";

const ACTOR: AuditContext = { actorType: "user", actorId: "container-test" };

async function withTempDir(
  fn: (dir: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dragonfly-container-" });
  try {
    await fn(dir, join(dir, "test.db"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("createContainer builds working repositories against a temp DB", async () => {
  await withTempDir(async (_dir, dbPath) => {
    const container = await createContainer({ dbPath });
    try {
      const { repositories } = container;

      // Every interface in the bundle is present and callable.
      const device = await repositories.devices.create({
        deviceClass: "enterprise_asset",
        enterpriseAssetType: "server",
        environment: "physical",
        hostname: "container-host",
        owner: "IT Ops",
        department: "Engineering",
        criticality: "low",
        businessImpact: "composition-root smoke test",
      }, ACTOR);

      const fetched = await repositories.devices.getById(device.id);
      assertEquals(fetched?.hostname, "container-host");

      // The create wrote an audit entry through the same connection — proves
      // the repositories share one live DB, not five disconnected ones.
      const audit = await repositories.auditLog.query(
        { entityType: "device", entityId: device.id },
        { limit: 10, offset: 0 },
      );
      assertEquals(audit.total, 1);
      assertEquals(audit.items[0].action, "create");
    } finally {
      await container.close();
    }
  });
});

Deno.test("createContainer resolves DB path from DRAGONFLY_DB_PATH when unset", async () => {
  await withTempDir(async (_dir, dbPath) => {
    const previous = Deno.env.get("DRAGONFLY_DB_PATH");
    Deno.env.set("DRAGONFLY_DB_PATH", dbPath);
    try {
      const container = await createContainer(); // no explicit dbPath
      try {
        // A working repository call confirms the env-derived path was opened.
        const page = await container.repositories.serviceProviders.list({
          limit: 1,
          offset: 0,
        });
        assertEquals(page.total, 0);
      } finally {
        await container.close();
      }
      // The env path was used, so the file exists on disk.
      assert((await Deno.stat(dbPath)).isFile);
    } finally {
      if (previous === undefined) {
        Deno.env.delete("DRAGONFLY_DB_PATH");
      } else {
        Deno.env.set("DRAGONFLY_DB_PATH", previous);
      }
    }
  });
});

Deno.test("getContainer constructs exactly one instance per process", async () => {
  await withTempDir(async (_dir, dbPath) => {
    const previous = Deno.env.get("DRAGONFLY_DB_PATH");
    Deno.env.set("DRAGONFLY_DB_PATH", dbPath);
    try {
      const first = await getContainer();
      const second = await getContainer();
      // Memoized singleton: same object, one connection for the whole process.
      assertStrictEquals(first, second);
    } finally {
      const container = await getContainer();
      await container.close();
      if (previous === undefined) {
        Deno.env.delete("DRAGONFLY_DB_PATH");
      } else {
        Deno.env.set("DRAGONFLY_DB_PATH", previous);
      }
    }
  });
});
