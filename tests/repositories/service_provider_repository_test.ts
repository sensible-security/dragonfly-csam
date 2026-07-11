// B4 contract tests: TursoServiceProviderRepository (ID.AM-04; Control 15
// groundwork). CRUD with audit entries, unique name, pagination.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { TursoAuditLogRepository } from "@/db/repositories/turso/audit_log_repository.ts";
import { TursoServiceProviderRepository } from "@/db/repositories/turso/service_provider_repository.ts";
import {
  type AuditContext,
  type CreateServiceProvider,
  DuplicateAssetError,
  NotFoundError,
} from "@/db/repositories/interfaces/mod.ts";
import { withTempDb } from "./helpers.ts";

const CTX: AuditContext = {
  actorType: "user",
  actorId: "analyst-1",
};

const PAGE = { limit: 50, offset: 0 };

function validInput(
  overrides: Partial<CreateServiceProvider> = {},
): CreateServiceProvider {
  return {
    name: "Acme Cloud Backup",
    servicesProvided: "offsite backup and restore",
    dataClassificationHandled: "confidential",
    contractReference: "MSA-2026-014",
    ...overrides,
  };
}

Deno.test("create persists the provider and writes a create audit entry", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoServiceProviderRepository(db);
    const audit = new TursoAuditLogRepository(db);

    const provider = await repo.create(validInput(), CTX);

    assert(provider.id.length > 0);
    assertEquals(provider.name, "Acme Cloud Backup");
    assertEquals(provider.servicesProvided, "offsite backup and restore");
    assertEquals(provider.dataClassificationHandled, "confidential");
    assertEquals(provider.contractReference, "MSA-2026-014");
    assertEquals(await repo.getById(provider.id), provider);

    const entries = await audit.query(
      {
        entityType: "service_provider",
        entityId: provider.id,
        action: "create",
      },
      PAGE,
    );
    assertEquals(entries.total, 1);
  });
});

Deno.test("create rejects a duplicate provider name", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoServiceProviderRepository(db);
    await repo.create(validInput(), CTX);
    await assertRejects(
      () => repo.create(validInput(), CTX),
      DuplicateAssetError,
    );
    assertEquals((await repo.list(PAGE)).total, 1);
  });
});

Deno.test("getById returns null for an unknown id", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoServiceProviderRepository(db);
    assertEquals(await repo.getById("ghost"), null);
  });
});

Deno.test("update patches fields and writes an update audit entry with a diff", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoServiceProviderRepository(db);
    const audit = new TursoAuditLogRepository(db);
    const provider = await repo.create(validInput(), CTX);

    const updated = await repo.update(
      provider.id,
      { servicesProvided: "backup, restore, DR runbooks" },
      CTX,
    );
    assertEquals(updated.servicesProvided, "backup, restore, DR runbooks");
    assertEquals(updated.name, "Acme Cloud Backup", "untouched field kept");

    const entries = await audit.query(
      {
        entityType: "service_provider",
        entityId: provider.id,
        action: "update",
      },
      PAGE,
    );
    assertEquals(entries.total, 1);
    assertEquals(
      JSON.parse(entries.items[0].beforeJson ?? "{}").servicesProvided,
      "offsite backup and restore",
    );

    await assertRejects(
      () => repo.update("ghost", { name: "x" }, CTX),
      NotFoundError,
    );
  });
});

Deno.test("list paginates with a correct total", async () => {
  await withTempDb(async (db) => {
    const repo = new TursoServiceProviderRepository(db);
    for (let i = 1; i <= 5; i++) {
      await repo.create(
        validInput({ name: `Provider ${i}`, contractReference: null }),
        CTX,
      );
    }

    const page1 = await repo.list({ limit: 2, offset: 0 });
    const page2 = await repo.list({ limit: 2, offset: 2 });
    const page3 = await repo.list({ limit: 2, offset: 4 });
    assertEquals(page1.total, 5);
    assertEquals(page1.items.length, 2);
    assertEquals(page2.items.length, 2);
    assertEquals(page3.items.length, 1);
    const ids = new Set(
      [...page1.items, ...page2.items, ...page3.items].map((p) => p.id),
    );
    assertEquals(ids.size, 5, "pages must not overlap");
  });
});
