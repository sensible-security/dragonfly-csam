// ReviewService (PRD §7). Human resolution of the reconciliation queue —
// ambiguous matches and new-asset-needing-enrichment items. Nothing here is
// auto-resolved (AGENTS.md §4.2); every action writes audit entries and closes
// the item. Bulk enrichment (gate decision 1) promotes many new_asset items at
// once with one criticality + business_impact, reporting per-item outcomes so a
// partial failure doesn't abort the rest. Depends only on repository interfaces.
import type {
  AuditContext,
  CreateDevice,
  CreateSoftware,
  Criticality,
  IAuditLogRepository,
  IDeviceRepository,
  IReviewQueueRepository,
  ISoftwareRepository,
  ISourceRecordRepository,
  Page,
  PageRequest,
  ReviewQueueFilter,
  ReviewQueueItem,
  ReviewQueueSort,
} from "../db/repositories/interfaces/mod.ts";
import { NotFoundError } from "../db/repositories/interfaces/mod.ts";
import type {
  DeviceObservation,
  SoftwareObservation,
} from "../connectors/mod.ts";

// The fields a source couldn't supply, provided by the analyst on promotion.
export interface RequiredFields {
  criticality: Criticality;
  businessImpact: string;
  // Devices also need an owner/department; supplied here when the observation
  // lacks them (a scanner rarely knows ownership).
  owner?: string;
  department?: string;
}

export interface BulkResult {
  succeeded: string[];
  failed: { itemId: string; code: string; message: string }[];
}

export interface ReviewService {
  list(
    filter: ReviewQueueFilter,
    sort: ReviewQueueSort,
    page: PageRequest,
  ): Promise<Page<ReviewQueueItem>>;
  merge(
    itemId: string,
    targetEntityId: string,
    ctx: AuditContext,
  ): Promise<void>;
  createNew(
    itemId: string,
    enrichment: RequiredFields,
    ctx: AuditContext,
  ): Promise<void>;
  reject(itemId: string, reason: string, ctx: AuditContext): Promise<void>;
  bulkCreateNew(
    itemIds: string[],
    enrichment: RequiredFields,
    ctx: AuditContext,
  ): Promise<BulkResult>;
}

export interface ReviewDeps {
  devices: IDeviceRepository;
  software: ISoftwareRepository;
  sourceRecords: ISourceRecordRepository;
  reviewQueue: IReviewQueueRepository;
  auditLog: IAuditLogRepository;
}

class ReviewActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReviewActionError";
  }
}

export class DefaultReviewService implements ReviewService {
  constructor(private readonly deps: ReviewDeps) {}

  list(
    filter: ReviewQueueFilter,
    sort: ReviewQueueSort,
    page: PageRequest,
  ): Promise<Page<ReviewQueueItem>> {
    return this.deps.reviewQueue.list(filter, sort, page);
  }

  async merge(
    itemId: string,
    targetEntityId: string,
    ctx: AuditContext,
  ): Promise<void> {
    const item = await this.#pendingItem(itemId);
    const record = await this.deps.sourceRecords.getById(item.sourceRecordId);
    if (!record) throw new NotFoundError("source_record", item.sourceRecordId);

    // Confirm the human-chosen candidate: attach any interfaces/IPs the
    // observation carries, link the staged record, and audit the merge. Field
    // precedence application mirrors auto-merge and is a roadmap refinement.
    if (item.entityKind === "device") {
      const target = await this.deps.devices.getById(targetEntityId);
      if (!target) throw new NotFoundError("device", targetEntityId);
      const obs = JSON.parse(record.normalizedPayload) as DeviceObservation;
      await this.#attachInterfaces(targetEntityId, obs, ctx);
    } else {
      const target = await this.deps.software.getById(targetEntityId);
      if (!target) throw new NotFoundError("software", targetEntityId);
    }

    await this.deps.sourceRecords.setReconciliationOutcome(
      record.id,
      "auto_merged",
      item.entityKind,
      targetEntityId,
    );
    await this.deps.auditLog.append({
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sourceAddress: ctx.sourceAddress,
      action: "merge",
      entityType: item.entityKind,
      entityId: targetEntityId,
      beforeJson: JSON.stringify({
        sourceRecordId: record.id,
        reviewItemId: itemId,
      }),
      afterJson: JSON.stringify({ entityId: targetEntityId }),
    });
    await this.deps.reviewQueue.resolve(
      itemId,
      { status: "merged", resolvedBy: ctx.actorId },
      ctx,
    );
  }

  async createNew(
    itemId: string,
    enrichment: RequiredFields,
    ctx: AuditContext,
  ): Promise<void> {
    const item = await this.#pendingItem(itemId);
    await this.#promote(item, enrichment, ctx);
  }

  async reject(
    itemId: string,
    reason: string,
    ctx: AuditContext,
  ): Promise<void> {
    const item = await this.#pendingItem(itemId);
    await this.deps.sourceRecords.setReconciliationOutcome(
      item.sourceRecordId,
      "rejected",
    );
    await this.deps.auditLog.append({
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sourceAddress: ctx.sourceAddress,
      action: "update",
      entityType: "review_queue_item",
      entityId: itemId,
      afterJson: JSON.stringify({ rejected: true, reason }),
    });
    await this.deps.reviewQueue.resolve(
      itemId,
      { status: "rejected", resolvedBy: ctx.actorId },
      ctx,
    );
  }

  async bulkCreateNew(
    itemIds: string[],
    enrichment: RequiredFields,
    ctx: AuditContext,
  ): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };
    for (const itemId of itemIds) {
      try {
        const item = await this.#pendingItem(itemId);
        await this.#promote(item, enrichment, ctx);
        result.succeeded.push(itemId);
      } catch (err) {
        const code = err instanceof ReviewActionError
          ? err.code
          : err instanceof NotFoundError
          ? "not_found"
          : "error";
        result.failed.push({
          itemId,
          code,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------

  async #pendingItem(itemId: string): Promise<ReviewQueueItem> {
    const item = await this.deps.reviewQueue.getById(itemId);
    if (!item) throw new NotFoundError("review_queue_item", itemId);
    if (item.status !== "pending") {
      throw new ReviewActionError(
        "not_pending",
        `review item ${itemId} is already ${item.status}`,
      );
    }
    return item;
  }

  // Promotes a new_asset item into a canonical asset (status pending_review /
  // unauthorized), stamps provenance, and closes the item created_new.
  async #promote(
    item: ReviewQueueItem,
    enrichment: RequiredFields,
    ctx: AuditContext,
  ): Promise<void> {
    const record = await this.deps.sourceRecords.getById(item.sourceRecordId);
    if (!record) throw new NotFoundError("source_record", item.sourceRecordId);

    if (item.entityKind === "device") {
      const obs = JSON.parse(record.normalizedPayload) as DeviceObservation;
      const create = this.#buildDevice(obs, enrichment);
      const device = await this.deps.devices.create(create, ctx);
      await this.#stampProvenance(
        "device",
        device.id,
        this.#deviceFields(obs),
        record.sourceId,
        obs.observedAt,
      );
      await this.#attachInterfaces(device.id, obs, ctx);
      await this.deps.sourceRecords.setReconciliationOutcome(
        record.id,
        "created",
        "device",
        device.id,
      );
    } else {
      const obs = JSON.parse(record.normalizedPayload) as SoftwareObservation;
      const create = this.#buildSoftware(obs, enrichment);
      const sw = await this.deps.software.create(create, ctx);
      await this.#stampProvenance(
        "software",
        sw.id,
        this.#softwareFields(obs),
        record.sourceId,
        obs.observedAt,
      );
      await this.deps.sourceRecords.setReconciliationOutcome(
        record.id,
        "created",
        "software",
        sw.id,
      );
    }

    await this.deps.reviewQueue.resolve(
      item.id,
      { status: "created_new", resolvedBy: ctx.actorId },
      ctx,
    );
  }

  #deviceFields(obs: DeviceObservation): Record<string, unknown> {
    const f: Record<string, unknown> = { ...obs.fields };
    const m = obs.matchKeys;
    if (m.hostname !== undefined) f.hostname = m.hostname;
    if (m.domain !== undefined) f.domain = m.domain;
    if (m.hardwareSerial !== undefined) f.hardwareSerial = m.hardwareSerial;
    if (m.cloudInstanceId !== undefined) f.cloudInstanceId = m.cloudInstanceId;
    return f;
  }

  #softwareFields(obs: SoftwareObservation): Record<string, unknown> {
    return { ...obs.fields };
  }

  #buildDevice(obs: DeviceObservation, e: RequiredFields): CreateDevice {
    const f = this.#deviceFields(obs);
    const need = (key: string, fallback?: string): string => {
      const v = f[key] ?? fallback;
      if (v === undefined || v === null || String(v).trim() === "") {
        throw new ReviewActionError(
          "missing_field",
          `cannot promote: required field "${key}" is absent from the observation and enrichment`,
        );
      }
      return String(v);
    };
    return {
      deviceClass: need("deviceClass") as CreateDevice["deviceClass"],
      enterpriseAssetType:
        (f.enterpriseAssetType ?? null) as CreateDevice["enterpriseAssetType"],
      endUserDeviceSubtype: (f.endUserDeviceSubtype ?? null) as CreateDevice[
        "endUserDeviceSubtype"
      ],
      environment: need("environment") as CreateDevice["environment"],
      status: "pending_review",
      hostname: need("hostname"),
      domain: (f.domain ?? null) as string | null,
      hardwareSerial: (f.hardwareSerial ?? null) as string | null,
      cloudInstanceId: (f.cloudInstanceId ?? null) as string | null,
      owner: need("owner", e.owner),
      department: need("department", e.department),
      criticality: e.criticality,
      businessImpact: e.businessImpact,
      notes: (f.notes ?? null) as string | null,
    };
  }

  #buildSoftware(obs: SoftwareObservation, e: RequiredFields): CreateSoftware {
    const f = obs.fields;
    if (f.softwareType === undefined || f.businessPurpose === undefined) {
      throw new ReviewActionError(
        "missing_field",
        "cannot promote software: softwareType and businessPurpose are required",
      );
    }
    return {
      title: obs.identity.title,
      publisher: obs.identity.publisher,
      version: obs.identity.version,
      softwareType: f.softwareType,
      componentType: f.componentType ?? null,
      authorizationStatus: "unauthorized",
      supportStatus: f.supportStatus ?? "supported",
      eolDate: f.eolDate ?? null,
      businessPurpose: f.businessPurpose,
      url: f.url ?? null,
      deploymentMechanism: f.deploymentMechanism ?? null,
      licenseCount: f.licenseCount ?? null,
      cpe: f.cpe ?? null,
      decommissionDate: f.decommissionDate ?? null,
      criticality: e.criticality,
      businessImpact: e.businessImpact,
    };
  }

  async #attachInterfaces(
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

  async #stampProvenance(
    entityType: "device" | "software",
    entityId: string,
    fields: Record<string, unknown>,
    sourceId: string,
    observedAt: string,
  ): Promise<void> {
    for (const [field, value] of Object.entries(fields)) {
      if (
        value === undefined || value === null || String(value).trim() === ""
      ) {
        continue;
      }
      await this.deps.sourceRecords.setFieldProvenance(
        entityType,
        entityId,
        field,
        sourceId,
        observedAt,
      );
    }
  }
}
