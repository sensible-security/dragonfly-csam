// Software repository (Safeguards 2.1, 2.2, 2.3; ID.AM-02, -05). Catalog
// entries are version-level: identity (title, publisher, version). Every
// mutation writes its audit entry inside the same transaction (PRD §3.4).
import {
  type AuditContext,
  type CreateSoftware,
  type CreateSoftwareException,
  type CreateSoftwareInstallation,
  type ISoftwareRepository,
  MissingCriticalityError,
  NotFoundError,
  type Page,
  type PageRequest,
  type Software,
  type SoftwareAuthorizationStatus,
  type SoftwareException,
  type SoftwareFilter,
  type SoftwareInstallation,
  type SupportStatus,
  TaxonomyViolationError,
  type UpdateSoftware,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  buildWhere,
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface SoftwareRow {
  id: string;
  title: string;
  publisher: string;
  version: string;
  software_type: Software["softwareType"];
  component_type: Software["componentType"];
  authorization_status: Software["authorizationStatus"];
  support_status: Software["supportStatus"];
  eol_date: string | null;
  business_purpose: string;
  url: string | null;
  deployment_mechanism: string | null;
  license_count: number | null;
  cpe: string | null;
  decommission_date: string | null;
  criticality: Software["criticality"];
  business_impact: string;
  created_at: string;
  updated_at: string;
}

interface InstallationRow {
  id: string;
  device_id: string;
  software_id: string;
  install_date: string | null;
  discovery_source_id: string | null;
  uninstalled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ExceptionRow {
  id: string;
  software_id: string;
  justification: string;
  approved_by: string;
  review_by: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

function toSoftware(row: SoftwareRow): Software {
  return {
    id: row.id,
    title: row.title,
    publisher: row.publisher,
    version: row.version,
    softwareType: row.software_type,
    componentType: row.component_type,
    authorizationStatus: row.authorization_status,
    supportStatus: row.support_status,
    eolDate: row.eol_date,
    businessPurpose: row.business_purpose,
    url: row.url,
    deploymentMechanism: row.deployment_mechanism,
    licenseCount: row.license_count,
    cpe: row.cpe,
    decommissionDate: row.decommission_date,
    criticality: row.criticality,
    businessImpact: row.business_impact,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toInstallation(row: InstallationRow): SoftwareInstallation {
  return {
    id: row.id,
    deviceId: row.device_id,
    softwareId: row.software_id,
    installDate: row.install_date,
    discoverySourceId: row.discovery_source_id,
    uninstalledAt: row.uninstalled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toException(row: ExceptionRow): SoftwareException {
  return {
    id: row.id,
    softwareId: row.software_id,
    justification: row.justification,
    approvedBy: row.approved_by,
    reviewBy: row.review_by,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// NIST ID.AM-05 — same untyped-caller re-check as the device repository
// (PLAN decision 6); SQL NOT NULLs remain the last line of defense.
function requireCriticality(
  criticality: unknown,
  businessImpact: unknown,
): void {
  if (typeof criticality !== "string" || criticality.trim() === "") {
    throw new MissingCriticalityError("criticality is required");
  }
  if (typeof businessImpact !== "string" || businessImpact.trim() === "") {
    throw new MissingCriticalityError("business_impact is required");
  }
}

export class TursoSoftwareRepository implements ISoftwareRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(input: CreateSoftware, ctx: AuditContext): Promise<Software> {
    requireCriticality(input.criticality, input.businessImpact);
    const ts = nowIso();
    const software: Software = {
      id: crypto.randomUUID(),
      title: input.title,
      publisher: input.publisher,
      version: input.version,
      softwareType: input.softwareType,
      componentType: input.componentType ?? null,
      authorizationStatus: input.authorizationStatus ?? "unauthorized",
      supportStatus: input.supportStatus ?? "supported",
      eolDate: input.eolDate ?? null,
      businessPurpose: input.businessPurpose,
      url: input.url ?? null,
      deploymentMechanism: input.deploymentMechanism ?? null,
      licenseCount: input.licenseCount ?? null,
      cpe: input.cpe ?? null,
      decommissionDate: input.decommissionDate ?? null,
      criticality: input.criticality,
      businessImpact: input.businessImpact,
      createdAt: ts,
      updatedAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO software (
             id, title, publisher, version, software_type, component_type,
             authorization_status, support_status, eol_date, business_purpose,
             url, deployment_mechanism, license_count, cpe, decommission_date,
             criticality, business_impact, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          software.id,
          software.title,
          software.publisher,
          software.version,
          software.softwareType,
          software.componentType,
          software.authorizationStatus,
          software.supportStatus,
          software.eolDate,
          software.businessPurpose,
          software.url,
          software.deploymentMechanism,
          software.licenseCount,
          software.cpe,
          software.decommissionDate,
          software.criticality,
          software.businessImpact,
          software.createdAt,
          software.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "software",
          entityId: software.id,
          afterJson: JSON.stringify(software),
        });
        return software;
      });
    } catch (err) {
      translateConstraintError(
        err,
        `software ${software.title} ${software.version} (${software.publisher})`,
      );
    }
  }

  async getById(id: string): Promise<Software | null> {
    const stmt = await this.db.prepare("SELECT * FROM software WHERE id = ?");
    const row = await stmt.get(id) as SoftwareRow | undefined;
    return row ? toSoftware(row) : null;
  }

  async list(
    filter: SoftwareFilter,
    page: PageRequest,
  ): Promise<Page<Software>> {
    const { where, params } = buildWhere([
      ["software_type = ?", filter.softwareType],
      ["authorization_status = ?", filter.authorizationStatus],
      ["support_status = ?", filter.supportStatus],
      ["criticality = ?", filter.criticality],
      ["eol_date IS NOT NULL AND eol_date < ?", filter.eolBefore],
      [
        "title LIKE ?",
        filter.titleContains === undefined
          ? undefined
          : `%${filter.titleContains}%`,
      ],
    ]);

    const countStmt = await this.db.prepare(
      `SELECT COUNT(*) AS total FROM software${where}`,
    );
    const { total } = await countStmt.get(...params) as { total: number };

    const listStmt = await this.db.prepare(
      `SELECT * FROM software${where}
       ORDER BY created_at, id LIMIT ? OFFSET ?`,
    );
    const rows = await listStmt.all(
      ...params,
      page.limit,
      page.offset,
    ) as SoftwareRow[];

    return {
      items: rows.map(toSoftware),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async update(
    id: string,
    patch: UpdateSoftware,
    ctx: AuditContext,
  ): Promise<Software> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("software", id);

    const merged: Software = {
      ...before,
      title: patch.title ?? before.title,
      publisher: patch.publisher ?? before.publisher,
      version: patch.version ?? before.version,
      softwareType: patch.softwareType ?? before.softwareType,
      componentType: patch.componentType !== undefined
        ? patch.componentType
        : before.componentType,
      eolDate: patch.eolDate !== undefined ? patch.eolDate : before.eolDate,
      businessPurpose: patch.businessPurpose ?? before.businessPurpose,
      url: patch.url !== undefined ? patch.url : before.url,
      deploymentMechanism: patch.deploymentMechanism !== undefined
        ? patch.deploymentMechanism
        : before.deploymentMechanism,
      licenseCount: patch.licenseCount !== undefined
        ? patch.licenseCount
        : before.licenseCount,
      cpe: patch.cpe !== undefined ? patch.cpe : before.cpe,
      decommissionDate: patch.decommissionDate !== undefined
        ? patch.decommissionDate
        : before.decommissionDate,
      criticality: patch.criticality ?? before.criticality,
      businessImpact: patch.businessImpact ?? before.businessImpact,
      updatedAt: nowIso(),
    };
    requireCriticality(merged.criticality, merged.businessImpact);

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `UPDATE software SET
             title = ?, publisher = ?, version = ?, software_type = ?,
             component_type = ?, eol_date = ?, business_purpose = ?, url = ?,
             deployment_mechanism = ?, license_count = ?, cpe = ?,
             decommission_date = ?, criticality = ?, business_impact = ?,
             updated_at = ?
           WHERE id = ?`,
        );
        await stmt.run(
          merged.title,
          merged.publisher,
          merged.version,
          merged.softwareType,
          merged.componentType,
          merged.eolDate,
          merged.businessPurpose,
          merged.url,
          merged.deploymentMechanism,
          merged.licenseCount,
          merged.cpe,
          merged.decommissionDate,
          merged.criticality,
          merged.businessImpact,
          merged.updatedAt,
          id,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "update",
          entityType: "software",
          entityId: id,
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(merged),
        });
        return merged;
      });
    } catch (err) {
      translateConstraintError(err, `software ${id}`);
    }
  }

  async setAuthorizationStatus(
    id: string,
    status: SoftwareAuthorizationStatus,
    ctx: AuditContext,
  ): Promise<Software> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("software", id);

    // PRD §2.3-exceptions invariant (SQL CHECK cannot span tables):
    // exception_documented requires at least one active exception row.
    if (status === "exception_documented") {
      const active = await this.listActiveExceptions(id);
      if (active.length === 0) {
        throw new TaxonomyViolationError(
          "authorization_status 'exception_documented' requires an active documented exception",
        );
      }
    }

    return await this.auditedStatusChange(id, before, ctx, {
      authorization_status: status,
    }, { authorizationStatus: status });
  }

  async setSupportStatus(
    id: string,
    status: SupportStatus,
    ctx: AuditContext,
  ): Promise<Software> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("software", id);
    return await this.auditedStatusChange(id, before, ctx, {
      support_status: status,
    }, { supportStatus: status });
  }

  private async auditedStatusChange(
    id: string,
    before: Software,
    ctx: AuditContext,
    columns: Record<string, string>,
    patch: Partial<Software>,
  ): Promise<Software> {
    const updatedAt = nowIso();
    const after: Software = { ...before, ...patch, updatedAt };
    const sets = Object.keys(columns).map((c) => `${c} = ?`).join(", ");

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `UPDATE software SET ${sets}, updated_at = ? WHERE id = ?`,
        );
        await stmt.run(...Object.values(columns), updatedAt, id);
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "status_change",
          entityType: "software",
          entityId: id,
          beforeJson: JSON.stringify({
            authorizationStatus: before.authorizationStatus,
            supportStatus: before.supportStatus,
          }),
          afterJson: JSON.stringify({
            authorizationStatus: after.authorizationStatus,
            supportStatus: after.supportStatus,
          }),
        });
        return after;
      });
    } catch (err) {
      translateConstraintError(err, `software ${id} status change`);
    }
  }

  async recordInstallation(
    input: CreateSoftwareInstallation,
    ctx: AuditContext,
  ): Promise<SoftwareInstallation> {
    const existingStmt = await this.db.prepare(
      "SELECT * FROM device_software WHERE device_id = ? AND software_id = ?",
    );
    const existing = await existingStmt.get(
      input.deviceId,
      input.softwareId,
    ) as InstallationRow | undefined;
    const ts = nowIso();

    try {
      return await withTransaction(this.db, async () => {
        // Reinstall reactivates the same row: one row per (device, software).
        if (existing) {
          const reactivated = toInstallation({
            ...existing,
            install_date: input.installDate ?? existing.install_date,
            discovery_source_id: input.discoverySourceId ??
              existing.discovery_source_id,
            uninstalled_at: null,
            updated_at: ts,
          });
          const stmt = await this.db.prepare(
            `UPDATE device_software SET
               install_date = ?, discovery_source_id = ?, uninstalled_at = NULL,
               updated_at = ?
             WHERE id = ?`,
          );
          await stmt.run(
            reactivated.installDate,
            reactivated.discoverySourceId,
            ts,
            existing.id,
          );
          await writeAuditEntry(this.db, {
            ...ctx,
            action: "update",
            entityType: "software_installation",
            entityId: existing.id,
            beforeJson: JSON.stringify(toInstallation(existing)),
            afterJson: JSON.stringify(reactivated),
          });
          return reactivated;
        }

        const installation: SoftwareInstallation = {
          id: crypto.randomUUID(),
          deviceId: input.deviceId,
          softwareId: input.softwareId,
          installDate: input.installDate ?? null,
          discoverySourceId: input.discoverySourceId ?? null,
          uninstalledAt: null,
          createdAt: ts,
          updatedAt: ts,
        };
        const stmt = await this.db.prepare(
          `INSERT INTO device_software (
             id, device_id, software_id, install_date, discovery_source_id,
             uninstalled_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        );
        await stmt.run(
          installation.id,
          installation.deviceId,
          installation.softwareId,
          installation.installDate,
          installation.discoverySourceId,
          installation.createdAt,
          installation.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "software_installation",
          entityId: installation.id,
          afterJson: JSON.stringify(installation),
        });
        return installation;
      });
    } catch (err) {
      translateConstraintError(
        err,
        `installation of ${input.softwareId} on ${input.deviceId}`,
      );
    }
  }

  async markUninstalled(
    deviceId: string,
    softwareId: string,
    uninstalledAt: string,
    ctx: AuditContext,
  ): Promise<void> {
    const existingStmt = await this.db.prepare(
      "SELECT * FROM device_software WHERE device_id = ? AND software_id = ?",
    );
    const existing = await existingStmt.get(deviceId, softwareId) as
      | InstallationRow
      | undefined;
    if (!existing) {
      throw new NotFoundError(
        "software_installation",
        `${deviceId}/${softwareId}`,
      );
    }

    const after = toInstallation({
      ...existing,
      uninstalled_at: uninstalledAt,
      updated_at: nowIso(),
    });
    try {
      await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `UPDATE device_software SET uninstalled_at = ?, updated_at = ?
           WHERE id = ?`,
        );
        await stmt.run(uninstalledAt, after.updatedAt, existing.id);
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "update",
          entityType: "software_installation",
          entityId: existing.id,
          beforeJson: JSON.stringify(toInstallation(existing)),
          afterJson: JSON.stringify(after),
        });
      });
    } catch (err) {
      translateConstraintError(err, `uninstall ${deviceId}/${softwareId}`);
    }
  }

  async listInstallationsForDevice(
    deviceId: string,
  ): Promise<SoftwareInstallation[]> {
    const stmt = await this.db.prepare(
      `SELECT * FROM device_software WHERE device_id = ?
       ORDER BY created_at, id`,
    );
    const rows = await stmt.all(deviceId) as InstallationRow[];
    return rows.map(toInstallation);
  }

  async listInstallationsForSoftware(
    softwareId: string,
  ): Promise<SoftwareInstallation[]> {
    const stmt = await this.db.prepare(
      `SELECT * FROM device_software WHERE software_id = ?
       ORDER BY created_at, id`,
    );
    const rows = await stmt.all(softwareId) as InstallationRow[];
    return rows.map(toInstallation);
  }

  async addException(
    input: CreateSoftwareException,
    ctx: AuditContext,
  ): Promise<SoftwareException> {
    const ts = nowIso();
    const exception: SoftwareException = {
      id: crypto.randomUUID(),
      softwareId: input.softwareId,
      justification: input.justification,
      approvedBy: input.approvedBy,
      reviewBy: input.reviewBy,
      revokedAt: null,
      createdAt: ts,
      updatedAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO exceptions (
             id, software_id, justification, approved_by, review_by,
             revoked_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        );
        await stmt.run(
          exception.id,
          exception.softwareId,
          exception.justification,
          exception.approvedBy,
          exception.reviewBy,
          exception.createdAt,
          exception.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "exception",
          entityId: exception.id,
          afterJson: JSON.stringify(exception),
        });
        return exception;
      });
    } catch (err) {
      translateConstraintError(err, `exception for ${input.softwareId}`);
    }
  }

  async revokeException(id: string, ctx: AuditContext): Promise<void> {
    const existingStmt = await this.db.prepare(
      "SELECT * FROM exceptions WHERE id = ?",
    );
    const existing = await existingStmt.get(id) as ExceptionRow | undefined;
    if (!existing) throw new NotFoundError("exception", id);

    const ts = nowIso();
    const after = toException({
      ...existing,
      revoked_at: ts,
      updated_at: ts,
    });
    try {
      await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          "UPDATE exceptions SET revoked_at = ?, updated_at = ? WHERE id = ?",
        );
        await stmt.run(ts, ts, id);
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "update",
          entityType: "exception",
          entityId: id,
          beforeJson: JSON.stringify(toException(existing)),
          afterJson: JSON.stringify(after),
        });
      });
    } catch (err) {
      translateConstraintError(err, `revoke exception ${id}`);
    }
  }

  async listActiveExceptions(softwareId: string): Promise<SoftwareException[]> {
    const stmt = await this.db.prepare(
      `SELECT * FROM exceptions
       WHERE software_id = ? AND revoked_at IS NULL
       ORDER BY created_at, id`,
    );
    const rows = await stmt.all(softwareId) as ExceptionRow[];
    return rows.map(toException);
  }
}
