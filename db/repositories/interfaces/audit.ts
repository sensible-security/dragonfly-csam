import type { AuditAction, AuditActorType } from "./taxonomy.ts";
import type { Page, PageRequest } from "./common.ts";

// AGENTS.md §4.4 / CIS Control 8 front-load. Append-only by contract:
// there is no update or delete on this repository, by omission.
export interface AuditEntry {
  id: string;
  occurredAt: string; // UTC ISO-8601
  actorType: AuditActorType;
  actorId: string;
  action: AuditAction;
  entityType: string; // e.g. device, software, service_provider, ...
  entityId: string;
  beforeJson: string | null; // null for create
  afterJson: string | null; // null for delete
  sourceAddress: string | null;
}

export interface CreateAuditEntry {
  occurredAt?: string; // defaults to now (UTC)
  actorType: AuditActorType;
  actorId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeJson?: string | null;
  afterJson?: string | null;
  sourceAddress?: string | null;
}

export interface AuditFilter {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: AuditAction;
  occurredAfter?: string;
  occurredBefore?: string;
}

export interface IAuditLogRepository {
  // Used by the other repositories inside their transactions (PRD §3.4).
  append(entry: CreateAuditEntry): Promise<AuditEntry>;
  query(filter: AuditFilter, page: PageRequest): Promise<Page<AuditEntry>>;
}
