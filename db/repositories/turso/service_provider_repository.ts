// Service provider repository (ID.AM-04; Control 15 groundwork). Mutations
// write their audit entries inside the same transaction (PRD §3.4).
import {
  type AuditContext,
  type CreateServiceProvider,
  type IServiceProviderRepository,
  NotFoundError,
  type Page,
  type PageRequest,
  type ServiceProvider,
  type UpdateServiceProvider,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface ProviderRow {
  id: string;
  name: string;
  services_provided: string;
  data_classification_handled: string;
  contract_reference: string | null;
  created_at: string;
  updated_at: string;
}

function toProvider(row: ProviderRow): ServiceProvider {
  return {
    id: row.id,
    name: row.name,
    servicesProvided: row.services_provided,
    dataClassificationHandled: row.data_classification_handled,
    contractReference: row.contract_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TursoServiceProviderRepository
  implements IServiceProviderRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(
    input: CreateServiceProvider,
    ctx: AuditContext,
  ): Promise<ServiceProvider> {
    const ts = nowIso();
    const provider: ServiceProvider = {
      id: crypto.randomUUID(),
      name: input.name,
      servicesProvided: input.servicesProvided,
      dataClassificationHandled: input.dataClassificationHandled,
      contractReference: input.contractReference ?? null,
      createdAt: ts,
      updatedAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO service_providers (
             id, name, services_provided, data_classification_handled,
             contract_reference, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          provider.id,
          provider.name,
          provider.servicesProvided,
          provider.dataClassificationHandled,
          provider.contractReference,
          provider.createdAt,
          provider.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "service_provider",
          entityId: provider.id,
          afterJson: JSON.stringify(provider),
        });
        return provider;
      });
    } catch (err) {
      translateConstraintError(err, `service provider ${provider.name}`);
    }
  }

  async getById(id: string): Promise<ServiceProvider | null> {
    const stmt = await this.db.prepare(
      "SELECT * FROM service_providers WHERE id = ?",
    );
    const row = await stmt.get(id) as ProviderRow | undefined;
    return row ? toProvider(row) : null;
  }

  async list(page: PageRequest): Promise<Page<ServiceProvider>> {
    const countStmt = await this.db.prepare(
      "SELECT COUNT(*) AS total FROM service_providers",
    );
    const { total } = await countStmt.get() as { total: number };

    const listStmt = await this.db.prepare(
      `SELECT * FROM service_providers
       ORDER BY name, id LIMIT ? OFFSET ?`,
    );
    const rows = await listStmt.all(page.limit, page.offset) as ProviderRow[];

    return {
      items: rows.map(toProvider),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async update(
    id: string,
    patch: UpdateServiceProvider,
    ctx: AuditContext,
  ): Promise<ServiceProvider> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("service_provider", id);

    const merged: ServiceProvider = {
      ...before,
      name: patch.name ?? before.name,
      servicesProvided: patch.servicesProvided ?? before.servicesProvided,
      dataClassificationHandled: patch.dataClassificationHandled ??
        before.dataClassificationHandled,
      contractReference: patch.contractReference !== undefined
        ? patch.contractReference
        : before.contractReference,
      updatedAt: nowIso(),
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `UPDATE service_providers SET
             name = ?, services_provided = ?, data_classification_handled = ?,
             contract_reference = ?, updated_at = ?
           WHERE id = ?`,
        );
        await stmt.run(
          merged.name,
          merged.servicesProvided,
          merged.dataClassificationHandled,
          merged.contractReference,
          merged.updatedAt,
          id,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "update",
          entityType: "service_provider",
          entityId: id,
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(merged),
        });
        return merged;
      });
    } catch (err) {
      translateConstraintError(err, `service provider ${id}`);
    }
  }
}
