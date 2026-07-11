import type { AuditActorType } from "./taxonomy.ts";

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

// Who is acting and from where — threaded through every mutation so the
// repository can write the audit record atomically with the change
// (PRD §3.4: audit entries are a repository invariant, not a service duty).
export interface AuditContext {
  actorType: AuditActorType;
  actorId: string;
  sourceAddress?: string;
}
