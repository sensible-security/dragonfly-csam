import type {
  AssetStatus,
  Criticality,
  DeviceClass,
  EndUserDeviceSubtype,
  EnterpriseAssetType,
  Environment,
} from "./taxonomy.ts";
import type { AuditContext, Page, PageRequest } from "./common.ts";

// Canonical hardware / removable-media asset (Safeguards 1.1, 1.2;
// ID.AM-01, -05). Field-for-field camelCase mirror of the `devices` table.
export interface Device {
  id: string;
  deviceClass: DeviceClass;
  // NULL iff removable_media (hierarchy CHECK in SQL, re-validated in repos).
  enterpriseAssetType: EnterpriseAssetType | null;
  // Only for end_user_device; may be null (unknown).
  endUserDeviceSubtype: EndUserDeviceSubtype | null;
  environment: Environment;
  status: AssetStatus;
  hostname: string;
  domain: string | null;
  hardwareSerial: string | null;
  cloudInstanceId: string | null;
  owner: string;
  department: string;
  criticality: Criticality;
  businessImpact: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkInterface {
  id: string;
  deviceId: string;
  // Normalized uppercase colon-separated.
  macAddress: string;
  interfaceName: string | null;
  createdAt: string;
  updatedAt: string;
}

// One row per (interface, IP, contiguous observation window) — IP history is
// append-only; the current IP is the row with the max lastSeen.
export interface IpAssignment {
  id: string;
  interfaceId: string;
  ipAddress: string;
  firstSeen: string;
  lastSeen: string;
}

export interface CreateDevice {
  deviceClass: DeviceClass;
  enterpriseAssetType?: EnterpriseAssetType | null;
  endUserDeviceSubtype?: EndUserDeviceSubtype | null;
  environment: Environment;
  status?: AssetStatus; // defaults to pending_review
  hostname: string;
  domain?: string | null;
  hardwareSerial?: string | null;
  cloudInstanceId?: string | null;
  owner: string;
  department: string;
  criticality: Criticality;
  businessImpact: string;
  notes?: string | null;
}

// Status is deliberately absent: transitions go through setStatus so every
// one is an audited status_change (Safeguard 1.2).
export type UpdateDevice = Partial<Omit<CreateDevice, "status">>;

export interface CreateNetworkInterface {
  macAddress: string;
  interfaceName?: string | null;
}

export interface DeviceFilter {
  status?: AssetStatus;
  deviceClass?: DeviceClass;
  enterpriseAssetType?: EnterpriseAssetType;
  environment?: Environment;
  criticality?: Criticality;
  department?: string;
  hostnameContains?: string;
}

export interface IDeviceRepository {
  create(input: CreateDevice, ctx: AuditContext): Promise<Device>;
  getById(id: string): Promise<Device | null>;
  list(filter: DeviceFilter, page: PageRequest): Promise<Page<Device>>;
  // Reconciliation match-key finders (PRD §6.1). Each returns every canonical
  // device matching the key; >1 result signals ambiguity to the engine. The
  // core schema indexes all four keys for exactly this use.
  findByCloudInstanceId(cloudInstanceId: string): Promise<Device[]>;
  findByHardwareSerial(hardwareSerial: string): Promise<Device[]>;
  // Matches any device owning any of the given MACs (normalized internally).
  findByMacAddresses(macAddresses: string[]): Promise<Device[]>;
  findByHostnameDomain(
    hostname: string,
    domain: string | null,
  ): Promise<Device[]>;
  update(id: string, patch: UpdateDevice, ctx: AuditContext): Promise<Device>;
  // Safeguard 1.2; writes a status_change audit entry atomically.
  setStatus(
    id: string,
    status: AssetStatus,
    ctx: AuditContext,
  ): Promise<Device>;
  addInterface(
    deviceId: string,
    input: CreateNetworkInterface,
    ctx: AuditContext,
  ): Promise<NetworkInterface>;
  listInterfaces(deviceId: string): Promise<NetworkInterface[]>;
  // Appends a new row for a changed IP; refreshes last_seen for the current
  // one. History is never rewritten.
  recordIpObservation(
    interfaceId: string,
    ip: string,
    observedAt: string,
    ctx: AuditContext,
  ): Promise<IpAssignment>;
  listIpHistory(interfaceId: string): Promise<IpAssignment[]>;
}
