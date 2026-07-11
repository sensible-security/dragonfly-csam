// Reconciliation engine — Reconcile → Merge (PRD §6). Correlates staged
// observations to canonical assets using the ordered match keys (do NOT reorder
// without approval — AGENTS.md §8), decides an outcome (auto_merge | review |
// new_asset), and merges with field-level source-of-truth precedence. Every
// merge/create is audited; ambiguous matches are queued for a human, never
// auto-merged. Depends only on repository interfaces + the connector registry.
import type {
  AssetStatus,
  AuditContext,
  CreateDevice,
  CreateSoftware,
  Device,
  IAuditLogRepository,
  IDeviceRepository,
  IIngestionBatchRepository,
  IReviewQueueRepository,
  ISoftwareRepository,
  ISourceRecordRepository,
  MatchKeyName,
  ReviewCandidate,
  ReviewConfidence,
  ReviewReason,
  Software,
  Source,
  SourceRecord,
  UpdateDevice,
  UpdateSoftware,
} from "../db/repositories/interfaces/mod.ts";
import { NotFoundError } from "../db/repositories/interfaces/mod.ts";
import type {
  ConnectorRegistry,
  DeviceObservation,
  Observation,
  SoftwareObservation,
  SourceType,
} from "../connectors/mod.ts";

export interface ReconciliationSummary {
  autoMerged: number;
  queuedForReview: number;
  created: number;
}

export interface ReconciliationService {
  reconcileBatch(
    batchId: string,
    ctx: AuditContext,
  ): Promise<ReconciliationSummary>;
}

export interface ReconciliationDeps {
  devices: IDeviceRepository;
  software: ISoftwareRepository;
  sourceRecords: ISourceRecordRepository;
  reviewQueue: IReviewQueueRepository;
  auditLog: IAuditLogRepository;
  batches: IIngestionBatchRepository;
  registry: ConnectorRegistry;
}

// Canonical device columns a merge may set through update()/setStatus().
const DEVICE_UPDATABLE = new Set([
  "deviceClass",
  "enterpriseAssetType",
  "endUserDeviceSubtype",
  "environment",
  "hostname",
  "domain",
  "hardwareSerial",
  "cloudInstanceId",
  "owner",
  "department",
  "criticality",
  "businessImpact",
  "notes",
]);
const SOFTWARE_UPDATABLE = new Set([
  "softwareType",
  "componentType",
  "eolDate",
  "businessPurpose",
  "url",
  "deploymentMechanism",
  "licenseCount",
  "cpe",
  "decommissionDate",
  "criticality",
  "businessImpact",
]);

function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

type FieldOwner = { sourceId: string; observedAt: string };

export class DefaultReconciliationService implements ReconciliationService {
  #precedenceCache = new Map<string, number>();

  constructor(private readonly deps: ReconciliationDeps) {}

  async reconcileBatch(
    batchId: string,
    ctx: AuditContext,
  ): Promise<ReconciliationSummary> {
    this.#precedenceCache.clear();
    const batch = await this.deps.batches.getById(batchId);
    if (!batch) throw new NotFoundError("ingestion_batch", batchId);
    const source = await this.deps.sourceRecords.getSourceById(batch.sourceId);
    if (!source) throw new NotFoundError("source", batch.sourceId);
    this.#precedenceCache.set(source.id, source.precedence);

    const connector = this.deps.registry.get(source.sourceType as SourceType);
    const providesRequired = connector?.capabilities.providesRequiredFields ??
      false;

    const pending = await this.deps.sourceRecords.listPendingBySource(
      source.id,
    );
    const parsed = pending.map((record) => ({
      record,
      obs: JSON.parse(record.normalizedPayload) as Observation,
    }));
    // Devices before software so installations can resolve their host (PRD A7).
    parsed.sort((a, b) =>
      (a.obs.kind === "device" ? 0 : 1) - (b.obs.kind === "device" ? 0 : 1)
    );

    const resolvedDevices = new Map<string, string>(); // externalId → deviceId
    const summary: ReconciliationSummary = {
      autoMerged: 0,
      queuedForReview: 0,
      created: 0,
    };

    for (const { record, obs } of parsed) {
      const outcome = obs.kind === "device"
        ? await this.#reconcileDevice(
          record,
          obs,
          source,
          providesRequired,
          ctx,
        )
        : await this.#reconcileSoftware(
          record,
          obs,
          source,
          providesRequired,
          resolvedDevices,
          ctx,
        );
      if (outcome.kind === "auto_merge") summary.autoMerged++;
      else if (outcome.kind === "created") summary.created++;
      else summary.queuedForReview++;
      if (obs.kind === "device" && outcome.entityId) {
        resolvedDevices.set(obs.externalId, outcome.entityId);
      }
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // Device reconciliation
  // -------------------------------------------------------------------------

  async #reconcileDevice(
    record: SourceRecord,
    obs: DeviceObservation,
    source: Source,
    providesRequired: boolean,
    ctx: AuditContext,
  ): Promise<{ kind: "auto_merge" | "created" | "review"; entityId?: string }> {
    const match = await this.#findDeviceMatch(obs);

    if (match === null) {
      if (providesRequired && this.#deviceRequiredPresent(obs)) {
        const device = await this.deps.devices.create(
          this.#buildCreateDevice(obs),
          ctx,
        );
        await this.#setProvenance(
          "device",
          device.id,
          this.#deviceIncomingFields(obs),
          source,
          obs.observedAt,
        );
        await this.#applyInterfaces(device.id, obs, ctx);
        await this.deps.sourceRecords.setReconciliationOutcome(
          record.id,
          "created",
          "device",
          device.id,
        );
        return { kind: "created", entityId: device.id };
      }
      await this.#enqueue(record, obs, "new_asset", "medium", [], ctx);
      await this.deps.sourceRecords.setReconciliationOutcome(
        record.id,
        "in_review",
      );
      return { kind: "review" };
    }

    const { key, candidates } = match;
    if (candidates.length > 1) {
      await this.#enqueue(
        record,
        obs,
        "ambiguous_match",
        "ambiguous",
        candidates.map((c) => ({
          entityId: c.id,
          matchedKey: key,
          score: 0.5,
          conflicts: [],
        })),
        ctx,
      );
      await this.deps.sourceRecords.setReconciliationOutcome(
        record.id,
        "in_review",
      );
      return { kind: "review" };
    }

    const candidate = candidates[0];
    const strong = key === "cloud_instance_id" || key === "hardware_serial";
    if (!strong) {
      const conflicts = this.#distinguishingConflicts(obs, candidate);
      if (conflicts.length > 0) {
        // The gate case: matched by a weak key (MAC/hostname) but a
        // distinguishing field differs → NEVER auto-merge.
        await this.#enqueue(record, obs, "conflicting_field", "medium", [{
          entityId: candidate.id,
          matchedKey: key,
          score: 0.6,
          conflicts,
        }], ctx);
        await this.deps.sourceRecords.setReconciliationOutcome(
          record.id,
          "in_review",
        );
        return { kind: "review" };
      }
    }

    await this.#mergeDevice(record, candidate, obs, source, key, ctx);
    await this.deps.sourceRecords.setReconciliationOutcome(
      record.id,
      "auto_merged",
      "device",
      candidate.id,
    );
    return { kind: "auto_merge", entityId: candidate.id };
  }

  async #findDeviceMatch(
    obs: DeviceObservation,
  ): Promise<{ key: MatchKeyName; candidates: Device[] } | null> {
    const m = obs.matchKeys;
    if (nonEmpty(m.cloudInstanceId)) {
      const c = await this.deps.devices.findByCloudInstanceId(
        m.cloudInstanceId!,
      );
      if (c.length) return { key: "cloud_instance_id", candidates: c };
    }
    if (nonEmpty(m.hardwareSerial)) {
      const c = await this.deps.devices.findByHardwareSerial(m.hardwareSerial!);
      if (c.length) return { key: "hardware_serial", candidates: c };
    }
    if (m.macAddresses && m.macAddresses.length > 0) {
      const c = await this.deps.devices.findByMacAddresses(m.macAddresses);
      if (c.length) return { key: "mac_address", candidates: c };
    }
    if (nonEmpty(m.hostname)) {
      const c = await this.deps.devices.findByHostnameDomain(
        m.hostname!,
        m.domain ?? null,
      );
      if (c.length) return { key: "hostname_domain", candidates: c };
    }
    return null;
  }

  #distinguishingConflicts(obs: DeviceObservation, cand: Device): string[] {
    const conflicts: string[] = [];
    const pairs: [string, unknown, unknown][] = [
      [
        "hostname",
        obs.matchKeys.hostname ?? obs.fields.hostname,
        cand.hostname,
      ],
      [
        "hardwareSerial",
        obs.matchKeys.hardwareSerial ?? obs.fields.hardwareSerial,
        cand.hardwareSerial,
      ],
      [
        "cloudInstanceId",
        obs.matchKeys.cloudInstanceId ?? obs.fields.cloudInstanceId,
        cand.cloudInstanceId,
      ],
    ];
    for (const [name, o, c] of pairs) {
      if (nonEmpty(o) && nonEmpty(c) && o !== c) conflicts.push(name);
    }
    return conflicts;
  }

  #deviceIncomingFields(obs: DeviceObservation): Record<string, unknown> {
    const f: Record<string, unknown> = { ...obs.fields };
    const m = obs.matchKeys;
    if (m.hostname !== undefined) f.hostname = m.hostname;
    if (m.domain !== undefined) f.domain = m.domain;
    if (m.hardwareSerial !== undefined) f.hardwareSerial = m.hardwareSerial;
    if (m.cloudInstanceId !== undefined) f.cloudInstanceId = m.cloudInstanceId;
    return f;
  }

  #deviceRequiredPresent(obs: DeviceObservation): boolean {
    const f = this.#deviceIncomingFields(obs);
    const required = [
      "deviceClass",
      "environment",
      "owner",
      "department",
      "criticality",
      "businessImpact",
      "hostname",
    ];
    if (!required.every((k) => nonEmpty(f[k]))) return false;
    // Enterprise assets must carry an asset type (schema hierarchy CHECK).
    if (
      f.deviceClass === "enterprise_asset" && !nonEmpty(f.enterpriseAssetType)
    ) {
      return false;
    }
    return true;
  }

  #buildCreateDevice(obs: DeviceObservation): CreateDevice {
    const f = this.#deviceIncomingFields(obs);
    return {
      deviceClass: f.deviceClass as CreateDevice["deviceClass"],
      enterpriseAssetType:
        (f.enterpriseAssetType ?? null) as CreateDevice["enterpriseAssetType"],
      endUserDeviceSubtype: (f.endUserDeviceSubtype ?? null) as CreateDevice[
        "endUserDeviceSubtype"
      ],
      environment: f.environment as CreateDevice["environment"],
      // New assets are born pending_review; a human authorizes explicitly (1.2).
      status: "pending_review",
      hostname: String(f.hostname),
      domain: (f.domain ?? null) as string | null,
      hardwareSerial: (f.hardwareSerial ?? null) as string | null,
      cloudInstanceId: (f.cloudInstanceId ?? null) as string | null,
      owner: String(f.owner),
      department: String(f.department),
      criticality: f.criticality as CreateDevice["criticality"],
      businessImpact: String(f.businessImpact),
      notes: (f.notes ?? null) as string | null,
    };
  }

  async #mergeDevice(
    record: SourceRecord,
    cand: Device,
    obs: DeviceObservation,
    source: Source,
    key: MatchKeyName,
    ctx: AuditContext,
  ): Promise<void> {
    const incoming = this.#deviceIncomingFields(obs);
    const owners = await this.#ownerMap("device", cand.id);
    const patch: UpdateDevice = {};
    let statusChange: AssetStatus | undefined;

    for (const [field, value] of Object.entries(incoming)) {
      if (!nonEmpty(value)) continue;
      if (!DEVICE_UPDATABLE.has(field) && field !== "status") continue;
      if (!await this.#wins(source, obs.observedAt, owners.get(field))) {
        continue;
      }
      await this.deps.sourceRecords.setFieldProvenance(
        "device",
        cand.id,
        field,
        source.id,
        obs.observedAt,
      );
      const current = (cand as unknown as Record<string, unknown>)[field];
      if (current === value) continue; // value unchanged → no audit-worthy update
      if (field === "status") statusChange = value as AssetStatus;
      else (patch as Record<string, unknown>)[field] = value;
    }

    if (Object.keys(patch).length > 0) {
      await this.deps.devices.update(cand.id, patch, ctx);
    }
    if (statusChange) {
      await this.deps.devices.setStatus(cand.id, statusChange, ctx);
    }
    await this.#applyInterfaces(cand.id, obs, ctx);
    await this.#writeMergeAudit("device", cand.id, record.id, key, ctx);
  }

  async #applyInterfaces(
    deviceId: string,
    obs: DeviceObservation,
    ctx: AuditContext,
  ): Promise<void> {
    for (const iface of obs.interfaces ?? []) {
      const existing = await this.deps.devices.listInterfaces(deviceId);
      const found = existing.find((e) => e.macAddress === iface.macAddress);
      const target = found ??
        await this.deps.devices.addInterface(
          deviceId,
          {
            macAddress: iface.macAddress,
            interfaceName: iface.interfaceName ?? null,
          },
          ctx,
        );
      for (const ip of iface.ips ?? []) {
        await this.deps.devices.recordIpObservation(
          target.id,
          ip.address,
          ip.observedAt,
          ctx,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Software reconciliation
  // -------------------------------------------------------------------------

  async #reconcileSoftware(
    record: SourceRecord,
    obs: SoftwareObservation,
    source: Source,
    providesRequired: boolean,
    resolvedDevices: Map<string, string>,
    ctx: AuditContext,
  ): Promise<{ kind: "auto_merge" | "created" | "review"; entityId?: string }> {
    const existing = await this.deps.software.findByIdentity(
      obs.identity.title,
      obs.identity.publisher,
      obs.identity.version,
    );

    if (existing) {
      await this.#mergeSoftware(record, existing, obs, source, ctx);
      await this.#linkInstallation(
        existing.id,
        obs,
        resolvedDevices,
        source,
        ctx,
      );
      await this.deps.sourceRecords.setReconciliationOutcome(
        record.id,
        "auto_merged",
        "software",
        existing.id,
      );
      return { kind: "auto_merge", entityId: existing.id };
    }

    if (providesRequired && this.#softwareRequiredPresent(obs)) {
      const sw = await this.deps.software.create(
        this.#buildCreateSoftware(obs),
        ctx,
      );
      await this.#setProvenance(
        "software",
        sw.id,
        this.#softwareIncomingFields(obs),
        source,
        obs.observedAt,
      );
      await this.#linkInstallation(sw.id, obs, resolvedDevices, source, ctx);
      await this.deps.sourceRecords.setReconciliationOutcome(
        record.id,
        "created",
        "software",
        sw.id,
      );
      return { kind: "created", entityId: sw.id };
    }

    await this.#enqueue(record, obs, "new_asset", "medium", [], ctx);
    await this.deps.sourceRecords.setReconciliationOutcome(
      record.id,
      "in_review",
    );
    return { kind: "review" };
  }

  #softwareIncomingFields(obs: SoftwareObservation): Record<string, unknown> {
    return {
      title: obs.identity.title,
      publisher: obs.identity.publisher,
      version: obs.identity.version,
      ...obs.fields,
    };
  }

  #softwareRequiredPresent(obs: SoftwareObservation): boolean {
    const f = obs.fields;
    return nonEmpty(f.softwareType) && nonEmpty(f.businessPurpose) &&
      nonEmpty(f.criticality) && nonEmpty(f.businessImpact);
  }

  #buildCreateSoftware(obs: SoftwareObservation): CreateSoftware {
    const f = obs.fields;
    return {
      title: obs.identity.title,
      publisher: obs.identity.publisher,
      version: obs.identity.version,
      softwareType: f.softwareType as CreateSoftware["softwareType"],
      componentType:
        (f.componentType ?? null) as CreateSoftware["componentType"],
      // New software is unauthorized until a human authorizes it (Safeguard 2.3).
      authorizationStatus: "unauthorized",
      supportStatus: f.supportStatus ?? "supported",
      eolDate: (f.eolDate ?? null) as string | null,
      businessPurpose: String(f.businessPurpose),
      url: (f.url ?? null) as string | null,
      deploymentMechanism: (f.deploymentMechanism ?? null) as string | null,
      licenseCount: (f.licenseCount ?? null) as number | null,
      cpe: (f.cpe ?? null) as string | null,
      decommissionDate: (f.decommissionDate ?? null) as string | null,
      criticality: f.criticality as CreateSoftware["criticality"],
      businessImpact: String(f.businessImpact),
    };
  }

  async #mergeSoftware(
    record: SourceRecord,
    cand: Software,
    obs: SoftwareObservation,
    source: Source,
    ctx: AuditContext,
  ): Promise<void> {
    const incoming = obs.fields as Record<string, unknown>;
    const owners = await this.#ownerMap("software", cand.id);
    const patch: UpdateSoftware = {};

    for (const [field, value] of Object.entries(incoming)) {
      if (!nonEmpty(value)) continue;
      if (!SOFTWARE_UPDATABLE.has(field)) continue;
      if (!await this.#wins(source, obs.observedAt, owners.get(field))) {
        continue;
      }
      await this.deps.sourceRecords.setFieldProvenance(
        "software",
        cand.id,
        field,
        source.id,
        obs.observedAt,
      );
      const current = (cand as unknown as Record<string, unknown>)[field];
      if (current === value) continue;
      (patch as Record<string, unknown>)[field] = value;
    }

    if (Object.keys(patch).length > 0) {
      await this.deps.software.update(cand.id, patch, ctx);
    }
    await this.#writeMergeAudit(
      "software",
      cand.id,
      record.id,
      "software_identity",
      ctx,
    );
  }

  async #linkInstallation(
    softwareId: string,
    obs: SoftwareObservation,
    resolvedDevices: Map<string, string>,
    source: Source,
    ctx: AuditContext,
  ): Promise<void> {
    if (!obs.installedOnExternalId) return;
    const deviceId = resolvedDevices.get(obs.installedOnExternalId);
    // Deferred (host queued/quarantined) — best-effort skip in Phase 3 (PRD A7).
    if (!deviceId) return;
    await this.deps.software.recordInstallation(
      { deviceId, softwareId, discoverySourceId: source.id },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  async #ownerMap(
    entityType: "device" | "software",
    entityId: string,
  ): Promise<Map<string, FieldOwner>> {
    const rows = await this.deps.sourceRecords.getFieldProvenance(
      entityType,
      entityId,
    );
    const map = new Map<string, FieldOwner>();
    for (const r of rows) {
      map.set(r.fieldName, { sourceId: r.sourceId, observedAt: r.observedAt });
    }
    return map;
  }

  // Field-precedence decision (PRD §6.3): higher rank overwrites; equal rank →
  // newer observedAt (last-writer-wins); lower rank never overwrites. A manual
  // override (precedence 100) is thereby immune to any automated source.
  async #wins(
    incoming: Source,
    incomingObservedAt: string,
    owner: FieldOwner | undefined,
  ): Promise<boolean> {
    if (!owner) return true;
    const ownerPrec = await this.#precedenceOf(owner.sourceId);
    if (incoming.precedence > ownerPrec) return true;
    if (incoming.precedence < ownerPrec) return false;
    return incomingObservedAt >= owner.observedAt;
  }

  async #precedenceOf(sourceId: string): Promise<number> {
    const cached = this.#precedenceCache.get(sourceId);
    if (cached !== undefined) return cached;
    const src = await this.deps.sourceRecords.getSourceById(sourceId);
    const prec = src?.precedence ?? 0;
    this.#precedenceCache.set(sourceId, prec);
    return prec;
  }

  async #setProvenance(
    entityType: "device" | "software",
    entityId: string,
    fields: Record<string, unknown>,
    source: Source,
    observedAt: string,
  ): Promise<void> {
    for (const [field, value] of Object.entries(fields)) {
      if (!nonEmpty(value)) continue;
      await this.deps.sourceRecords.setFieldProvenance(
        entityType,
        entityId,
        field,
        source.id,
        observedAt,
      );
    }
  }

  async #writeMergeAudit(
    entityType: "device" | "software",
    entityId: string,
    sourceRecordId: string,
    key: MatchKeyName,
    ctx: AuditContext,
  ): Promise<void> {
    await this.deps.auditLog.append({
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sourceAddress: ctx.sourceAddress,
      action: "merge",
      entityType,
      entityId,
      beforeJson: JSON.stringify({ sourceRecordId, matchedKey: key }),
      afterJson: JSON.stringify({ entityId }),
    });
  }

  async #enqueue(
    record: SourceRecord,
    obs: Observation,
    reason: ReviewReason,
    confidence: ReviewConfidence,
    candidates: ReviewCandidate[],
    ctx: AuditContext,
  ): Promise<void> {
    await this.deps.reviewQueue.enqueue({
      sourceRecordId: record.id,
      entityKind: obs.kind,
      reason,
      confidence,
      candidates,
      attributes: this.#projectAttributes(obs),
    }, ctx);
  }

  #projectAttributes(obs: Observation): Record<string, string | null> {
    if (obs.kind === "device") {
      return {
        kind: "device",
        hostname: (obs.matchKeys.hostname ?? obs.fields.hostname ?? null) as
          | string
          | null,
        department: (obs.fields.department ?? null) as string | null,
        criticality: (obs.fields.criticality ?? null) as string | null,
      };
    }
    return {
      kind: "software",
      title: obs.identity.title,
      publisher: obs.identity.publisher,
      version: obs.identity.version,
    };
  }
}
