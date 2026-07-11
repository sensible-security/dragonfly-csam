import type {
  Criticality,
  SoftwareAssetType,
  SoftwareAuthorizationStatus,
  SoftwareComponentType,
  SupportStatus,
} from "./taxonomy.ts";
import type { AuditContext, Page, PageRequest } from "./common.ts";

// Version-level software catalog entry (Safeguards 2.1, 2.2, 2.3;
// ID.AM-02, -05). Identity is (title, publisher, version) — PRD Assumption 6.
export interface Software {
  id: string;
  title: string;
  publisher: string;
  version: string;
  softwareType: SoftwareAssetType;
  // Null allowed; forbidden for firmware (hierarchy CHECK).
  componentType: SoftwareComponentType | null;
  authorizationStatus: SoftwareAuthorizationStatus;
  supportStatus: SupportStatus;
  eolDate: string | null;
  businessPurpose: string;
  url: string | null;
  deploymentMechanism: string | null;
  licenseCount: number | null;
  // Control 7 hook — CVE binding later.
  cpe: string | null;
  decommissionDate: string | null;
  criticality: Criticality;
  businessImpact: string;
  createdAt: string;
  updatedAt: string;
}

// Per-installation facts live here, not on the catalog entry (Safeguard 2.1).
export interface SoftwareInstallation {
  id: string;
  deviceId: string;
  softwareId: string;
  installDate: string | null;
  discoverySourceId: string | null;
  uninstalledAt: string | null; // null = currently installed
  createdAt: string;
  updatedAt: string;
}

// Documented exception (Safeguards 2.2 / 2.3). Active ⇔ revokedAt is null.
export interface SoftwareException {
  id: string;
  softwareId: string;
  justification: string;
  approvedBy: string; // identity string until Phase 5 auth
  reviewBy: string; // date the exception must be re-reviewed
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSoftware {
  title: string;
  publisher: string;
  version: string;
  softwareType: SoftwareAssetType;
  componentType?: SoftwareComponentType | null;
  authorizationStatus?: SoftwareAuthorizationStatus; // defaults to unauthorized
  supportStatus?: SupportStatus; // defaults to supported
  eolDate?: string | null;
  businessPurpose: string;
  url?: string | null;
  deploymentMechanism?: string | null;
  licenseCount?: number | null;
  cpe?: string | null;
  decommissionDate?: string | null;
  criticality: Criticality;
  businessImpact: string;
}

// Authorization/support statuses are deliberately absent: they change only
// through the dedicated audited setters below.
export type UpdateSoftware = Partial<
  Omit<CreateSoftware, "authorizationStatus" | "supportStatus">
>;

export interface CreateSoftwareInstallation {
  deviceId: string;
  softwareId: string;
  installDate?: string | null;
  discoverySourceId?: string | null;
}

export interface CreateSoftwareException {
  softwareId: string;
  justification: string;
  approvedBy: string;
  reviewBy: string;
}

export interface SoftwareFilter {
  softwareType?: SoftwareAssetType;
  authorizationStatus?: SoftwareAuthorizationStatus;
  supportStatus?: SupportStatus;
  criticality?: Criticality;
  eolBefore?: string; // ISO date — "what goes EOL before X"
  titleContains?: string;
}

export interface ISoftwareRepository {
  create(input: CreateSoftware, ctx: AuditContext): Promise<Software>;
  getById(id: string): Promise<Software | null>;
  list(filter: SoftwareFilter, page: PageRequest): Promise<Page<Software>>;
  // Reconciliation exact-identity match (PRD §6.1): (title, publisher, version)
  // is UNIQUE in the schema, so at most one row.
  findByIdentity(
    title: string,
    publisher: string,
    version: string,
  ): Promise<Software | null>;
  update(
    id: string,
    patch: UpdateSoftware,
    ctx: AuditContext,
  ): Promise<Software>;
  // Safeguard 2.3. exception_documented requires an active exception row —
  // service-layer/repository invariant (SQL CHECK cannot span tables).
  setAuthorizationStatus(
    id: string,
    status: SoftwareAuthorizationStatus,
    ctx: AuditContext,
  ): Promise<Software>;
  // Safeguard 2.2.
  setSupportStatus(
    id: string,
    status: SupportStatus,
    ctx: AuditContext,
  ): Promise<Software>;
  recordInstallation(
    input: CreateSoftwareInstallation,
    ctx: AuditContext,
  ): Promise<SoftwareInstallation>;
  markUninstalled(
    deviceId: string,
    softwareId: string,
    uninstalledAt: string,
    ctx: AuditContext,
  ): Promise<void>;
  listInstallationsForDevice(deviceId: string): Promise<SoftwareInstallation[]>;
  listInstallationsForSoftware(
    softwareId: string,
  ): Promise<SoftwareInstallation[]>;
  addException(
    input: CreateSoftwareException,
    ctx: AuditContext,
  ): Promise<SoftwareException>;
  revokeException(id: string, ctx: AuditContext): Promise<void>;
  listActiveExceptions(softwareId: string): Promise<SoftwareException[]>;
}
