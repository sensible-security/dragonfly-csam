// Asset-detail DTO assembly (routes PRD §4.1/§4.2) shared by the JSON detail
// routes and the server-rendered detail pages. Composes repository reads only
// (Gate Q2: no per-entity CRUD service); interface types exclusively — no SQL,
// no driver.
import type { Repositories } from "../../db/container.ts";
import type {
  Device,
  FieldProvenance,
  IpAssignment,
  NetworkInterface,
  Software,
  SoftwareException,
  SoftwareInstallation,
  SourceRecord,
} from "../../db/repositories/interfaces/mod.ts";

// Provenance rows and staging records are annotated with the human-readable
// source name (the UI's provenance panel shows sources, not UUIDs).
export interface ProvenanceEntry {
  field: FieldProvenance;
  sourceName: string | null;
}

export interface SourceRecordEntry {
  record: SourceRecord;
  sourceName: string | null;
}

export interface DeviceDetail {
  device: Device;
  interfaces: { interface: NetworkInterface; ipHistory: IpAssignment[] }[];
  installations: {
    installation: SoftwareInstallation;
    software: Software | null;
  }[];
  provenance: ProvenanceEntry[];
  sourceRecords: SourceRecordEntry[];
}

export interface SoftwareDetail {
  software: Software;
  installations: {
    installation: SoftwareInstallation;
    device: Device | null;
  }[];
  exceptions: SoftwareException[];
  provenance: ProvenanceEntry[];
  sourceRecords: SourceRecordEntry[];
}

// Resolves source ids to names once per detail request (memoized per call).
function sourceNameResolver(repositories: Repositories) {
  const cache = new Map<string, string | null>();
  return async (sourceId: string): Promise<string | null> => {
    const hit = cache.get(sourceId);
    if (hit !== undefined) return hit;
    const source = await repositories.sourceRecords.getSourceById(sourceId);
    const name = source?.name ?? null;
    cache.set(sourceId, name);
    return name;
  };
}

async function annotateProvenance(
  repositories: Repositories,
  entityType: "device" | "software",
  entityId: string,
): Promise<
  { provenance: ProvenanceEntry[]; sourceRecords: SourceRecordEntry[] }
> {
  const resolve = sourceNameResolver(repositories);

  const fields = await repositories.sourceRecords.getFieldProvenance(
    entityType,
    entityId,
  );
  const provenance: ProvenanceEntry[] = [];
  for (const field of fields) {
    provenance.push({ field, sourceName: await resolve(field.sourceId) });
  }

  const records = await repositories.sourceRecords.listByMatchedEntity(
    entityType,
    entityId,
  );
  const sourceRecords: SourceRecordEntry[] = [];
  for (const record of records) {
    sourceRecords.push({ record, sourceName: await resolve(record.sourceId) });
  }

  return { provenance, sourceRecords };
}

// Null when the device does not exist — callers turn that into a 404.
export async function buildDeviceDetail(
  repositories: Repositories,
  id: string,
): Promise<DeviceDetail | null> {
  const device = await repositories.devices.getById(id);
  if (!device) return null;

  const nics = await repositories.devices.listInterfaces(id);
  const interfaces: DeviceDetail["interfaces"] = [];
  for (const nic of nics) {
    interfaces.push({
      interface: nic,
      ipHistory: await repositories.devices.listIpHistory(nic.id),
    });
  }

  const installs = await repositories.software.listInstallationsForDevice(id);
  const installations: DeviceDetail["installations"] = [];
  for (const installation of installs) {
    installations.push({
      installation,
      software: await repositories.software.getById(installation.softwareId),
    });
  }

  const { provenance, sourceRecords } = await annotateProvenance(
    repositories,
    "device",
    id,
  );

  return { device, interfaces, installations, provenance, sourceRecords };
}

// Null when the software does not exist — callers turn that into a 404.
export async function buildSoftwareDetail(
  repositories: Repositories,
  id: string,
): Promise<SoftwareDetail | null> {
  const software = await repositories.software.getById(id);
  if (!software) return null;

  const installs = await repositories.software.listInstallationsForSoftware(id);
  const installations: SoftwareDetail["installations"] = [];
  for (const installation of installs) {
    installations.push({
      installation,
      device: await repositories.devices.getById(installation.deviceId),
    });
  }

  const exceptions = await repositories.software.listActiveExceptions(id);

  const { provenance, sourceRecords } = await annotateProvenance(
    repositories,
    "software",
    id,
  );

  return { software, installations, exceptions, provenance, sourceRecords };
}
