// Device repository (Safeguards 1.1, 1.2; ID.AM-01, -05). Hand-written SQL
// per AGENTS.md ORM policy; every mutation writes its audit entry inside the
// same transaction (PRD §3.4).
import {
  type AssetStatus,
  type AuditContext,
  type CreateDevice,
  type CreateNetworkInterface,
  type Device,
  type DeviceFilter,
  type IDeviceRepository,
  type IpAssignment,
  MissingCriticalityError,
  type NetworkInterface,
  NotFoundError,
  type Page,
  type PageRequest,
  TaxonomyViolationError,
  type UpdateDevice,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  buildWhere,
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface DeviceRow {
  id: string;
  device_class: Device["deviceClass"];
  enterprise_asset_type: Device["enterpriseAssetType"];
  end_user_device_subtype: Device["endUserDeviceSubtype"];
  environment: Device["environment"];
  status: Device["status"];
  hostname: string;
  domain: string | null;
  hardware_serial: string | null;
  cloud_instance_id: string | null;
  owner: string;
  department: string;
  criticality: Device["criticality"];
  business_impact: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface InterfaceRow {
  id: string;
  device_id: string;
  mac_address: string;
  interface_name: string | null;
  created_at: string;
  updated_at: string;
}

interface IpRow {
  id: string;
  interface_id: string;
  ip_address: string;
  first_seen: string;
  last_seen: string;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    deviceClass: row.device_class,
    enterpriseAssetType: row.enterprise_asset_type,
    endUserDeviceSubtype: row.end_user_device_subtype,
    environment: row.environment,
    status: row.status,
    hostname: row.hostname,
    domain: row.domain,
    hardwareSerial: row.hardware_serial,
    cloudInstanceId: row.cloud_instance_id,
    owner: row.owner,
    department: row.department,
    criticality: row.criticality,
    businessImpact: row.business_impact,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toInterface(row: InterfaceRow): NetworkInterface {
  return {
    id: row.id,
    deviceId: row.device_id,
    macAddress: row.mac_address,
    interfaceName: row.interface_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIpAssignment(row: IpRow): IpAssignment {
  return {
    id: row.id,
    interfaceId: row.interface_id,
    ipAddress: row.ip_address,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

// NIST ID.AM-05: required and non-empty on every asset. The type system
// enforces presence for typed callers; untyped input is re-checked here
// (PLAN decision 6) with the SQL NOT NULLs as the last line of defense.
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

// Normalizes any common MAC notation (colon, dash, dot, bare) to uppercase
// colon-separated — the canonical form the schema documents and Phase 3
// reconciliation matches on.
function normalizeMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12 || !/^[0-9A-F]{12}$/.test(hex)) {
    throw new TaxonomyViolationError(`not a valid MAC address: ${mac}`);
  }
  return hex.match(/.{2}/g)!.join(":");
}

export class TursoDeviceRepository implements IDeviceRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(input: CreateDevice, ctx: AuditContext): Promise<Device> {
    requireCriticality(input.criticality, input.businessImpact);
    const ts = nowIso();
    const device: Device = {
      id: crypto.randomUUID(),
      deviceClass: input.deviceClass,
      enterpriseAssetType: input.enterpriseAssetType ?? null,
      endUserDeviceSubtype: input.endUserDeviceSubtype ?? null,
      environment: input.environment,
      status: input.status ?? "pending_review",
      hostname: input.hostname,
      domain: input.domain ?? null,
      hardwareSerial: input.hardwareSerial ?? null,
      cloudInstanceId: input.cloudInstanceId ?? null,
      owner: input.owner,
      department: input.department,
      criticality: input.criticality,
      businessImpact: input.businessImpact,
      notes: input.notes ?? null,
      createdAt: ts,
      updatedAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO devices (
             id, device_class, enterprise_asset_type, end_user_device_subtype,
             environment, status, hostname, domain, hardware_serial,
             cloud_instance_id, owner, department, criticality,
             business_impact, notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          device.id,
          device.deviceClass,
          device.enterpriseAssetType,
          device.endUserDeviceSubtype,
          device.environment,
          device.status,
          device.hostname,
          device.domain,
          device.hardwareSerial,
          device.cloudInstanceId,
          device.owner,
          device.department,
          device.criticality,
          device.businessImpact,
          device.notes,
          device.createdAt,
          device.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "device",
          entityId: device.id,
          afterJson: JSON.stringify(device),
        });
        return device;
      });
    } catch (err) {
      translateConstraintError(err, `device ${device.hostname}`);
    }
  }

  async getById(id: string): Promise<Device | null> {
    const stmt = await this.db.prepare("SELECT * FROM devices WHERE id = ?");
    const row = await stmt.get(id) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  async list(filter: DeviceFilter, page: PageRequest): Promise<Page<Device>> {
    const { where, params } = buildWhere([
      ["status = ?", filter.status],
      ["device_class = ?", filter.deviceClass],
      ["enterprise_asset_type = ?", filter.enterpriseAssetType],
      ["environment = ?", filter.environment],
      ["criticality = ?", filter.criticality],
      ["department = ?", filter.department],
      [
        "hostname LIKE ?",
        filter.hostnameContains === undefined
          ? undefined
          : `%${filter.hostnameContains}%`,
      ],
    ]);

    const countStmt = await this.db.prepare(
      `SELECT COUNT(*) AS total FROM devices${where}`,
    );
    const { total } = await countStmt.get(...params) as { total: number };

    const listStmt = await this.db.prepare(
      `SELECT * FROM devices${where}
       ORDER BY created_at, id LIMIT ? OFFSET ?`,
    );
    const rows = await listStmt.all(
      ...params,
      page.limit,
      page.offset,
    ) as DeviceRow[];

    return {
      items: rows.map(toDevice),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async update(
    id: string,
    patch: UpdateDevice,
    ctx: AuditContext,
  ): Promise<Device> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("device", id);

    const merged: Device = {
      ...before,
      deviceClass: patch.deviceClass ?? before.deviceClass,
      enterpriseAssetType: patch.enterpriseAssetType !== undefined
        ? patch.enterpriseAssetType
        : before.enterpriseAssetType,
      endUserDeviceSubtype: patch.endUserDeviceSubtype !== undefined
        ? patch.endUserDeviceSubtype
        : before.endUserDeviceSubtype,
      environment: patch.environment ?? before.environment,
      hostname: patch.hostname ?? before.hostname,
      domain: patch.domain !== undefined ? patch.domain : before.domain,
      hardwareSerial: patch.hardwareSerial !== undefined
        ? patch.hardwareSerial
        : before.hardwareSerial,
      cloudInstanceId: patch.cloudInstanceId !== undefined
        ? patch.cloudInstanceId
        : before.cloudInstanceId,
      owner: patch.owner ?? before.owner,
      department: patch.department ?? before.department,
      criticality: patch.criticality ?? before.criticality,
      businessImpact: patch.businessImpact ?? before.businessImpact,
      notes: patch.notes !== undefined ? patch.notes : before.notes,
      updatedAt: nowIso(),
    };
    requireCriticality(merged.criticality, merged.businessImpact);

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `UPDATE devices SET
             device_class = ?, enterprise_asset_type = ?,
             end_user_device_subtype = ?, environment = ?, hostname = ?,
             domain = ?, hardware_serial = ?, cloud_instance_id = ?,
             owner = ?, department = ?, criticality = ?, business_impact = ?,
             notes = ?, updated_at = ?
           WHERE id = ?`,
        );
        await stmt.run(
          merged.deviceClass,
          merged.enterpriseAssetType,
          merged.endUserDeviceSubtype,
          merged.environment,
          merged.hostname,
          merged.domain,
          merged.hardwareSerial,
          merged.cloudInstanceId,
          merged.owner,
          merged.department,
          merged.criticality,
          merged.businessImpact,
          merged.notes,
          merged.updatedAt,
          id,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "update",
          entityType: "device",
          entityId: id,
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(merged),
        });
        return merged;
      });
    } catch (err) {
      translateConstraintError(err, `device ${id}`);
    }
  }

  async setStatus(
    id: string,
    status: AssetStatus,
    ctx: AuditContext,
  ): Promise<Device> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("device", id);

    const updatedAt = nowIso();
    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          "UPDATE devices SET status = ?, updated_at = ? WHERE id = ?",
        );
        await stmt.run(status, updatedAt, id);
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "status_change",
          entityType: "device",
          entityId: id,
          beforeJson: JSON.stringify({ status: before.status }),
          afterJson: JSON.stringify({ status }),
        });
        return { ...before, status, updatedAt };
      });
    } catch (err) {
      translateConstraintError(err, `device ${id} status ${status}`);
    }
  }

  async addInterface(
    deviceId: string,
    input: CreateNetworkInterface,
    ctx: AuditContext,
  ): Promise<NetworkInterface> {
    if (!await this.getById(deviceId)) {
      throw new NotFoundError("device", deviceId);
    }
    const ts = nowIso();
    const iface: NetworkInterface = {
      id: crypto.randomUUID(),
      deviceId,
      macAddress: normalizeMac(input.macAddress),
      interfaceName: input.interfaceName ?? null,
      createdAt: ts,
      updatedAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO network_interfaces (
             id, device_id, mac_address, interface_name, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          iface.id,
          iface.deviceId,
          iface.macAddress,
          iface.interfaceName,
          iface.createdAt,
          iface.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "network_interface",
          entityId: iface.id,
          afterJson: JSON.stringify(iface),
        });
        return iface;
      });
    } catch (err) {
      translateConstraintError(
        err,
        `interface ${iface.macAddress} on device ${deviceId}`,
      );
    }
  }

  async listInterfaces(deviceId: string): Promise<NetworkInterface[]> {
    const stmt = await this.db.prepare(
      `SELECT * FROM network_interfaces WHERE device_id = ?
       ORDER BY created_at, id`,
    );
    const rows = await stmt.all(deviceId) as InterfaceRow[];
    return rows.map(toInterface);
  }

  async recordIpObservation(
    interfaceId: string,
    ip: string,
    observedAt: string,
    ctx: AuditContext,
  ): Promise<IpAssignment> {
    const ifaceStmt = await this.db.prepare(
      "SELECT id FROM network_interfaces WHERE id = ?",
    );
    if (!await ifaceStmt.get(interfaceId)) {
      throw new NotFoundError("network_interface", interfaceId);
    }

    const currentStmt = await this.db.prepare(
      `SELECT * FROM ip_assignments WHERE interface_id = ?
       ORDER BY last_seen DESC, first_seen DESC LIMIT 1`,
    );
    const current = await currentStmt.get(interfaceId) as IpRow | undefined;

    try {
      return await withTransaction(this.db, async () => {
        // Same current IP: refresh last_seen on the same row — history is
        // append-only and never rewritten.
        if (current && current.ip_address === ip) {
          const stmt = await this.db.prepare(
            "UPDATE ip_assignments SET last_seen = ? WHERE id = ?",
          );
          await stmt.run(observedAt, current.id);
          const refreshed = toIpAssignment({
            ...current,
            last_seen: observedAt,
          });
          await writeAuditEntry(this.db, {
            ...ctx,
            action: "update",
            entityType: "ip_assignment",
            entityId: current.id,
            beforeJson: JSON.stringify(toIpAssignment(current)),
            afterJson: JSON.stringify(refreshed),
          });
          return refreshed;
        }

        const assignment: IpAssignment = {
          id: crypto.randomUUID(),
          interfaceId,
          ipAddress: ip,
          firstSeen: observedAt,
          lastSeen: observedAt,
        };
        const stmt = await this.db.prepare(
          `INSERT INTO ip_assignments (
             id, interface_id, ip_address, first_seen, last_seen
           ) VALUES (?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          assignment.id,
          assignment.interfaceId,
          assignment.ipAddress,
          assignment.firstSeen,
          assignment.lastSeen,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "ip_assignment",
          entityId: assignment.id,
          afterJson: JSON.stringify(assignment),
        });
        return assignment;
      });
    } catch (err) {
      translateConstraintError(err, `ip observation on ${interfaceId}`);
    }
  }

  async listIpHistory(interfaceId: string): Promise<IpAssignment[]> {
    const stmt = await this.db.prepare(
      `SELECT * FROM ip_assignments WHERE interface_id = ?
       ORDER BY first_seen, id`,
    );
    const rows = await stmt.all(interfaceId) as IpRow[];
    return rows.map(toIpAssignment);
  }
}
