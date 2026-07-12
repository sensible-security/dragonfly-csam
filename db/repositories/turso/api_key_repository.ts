// API-key repository (auth PRD §4, Assumption 6). Connector principals for
// push ingest. The key itself is never stored — only its SHA-256 — and the
// domain ApiKey (audit snapshots, listings) never carries the hash. Revoke is
// audited as status_change; last_used_at is best-effort telemetry, unaudited.
import {
  type ApiKey,
  type ApiKeyStatus,
  type AuditContext,
  type CreateApiKey,
  type IApiKeyRepository,
  NotFoundError,
  type Page,
  type PageRequest,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface ApiKeyRow {
  id: string;
  name: string;
  status: ApiKeyStatus;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

// SELECT list deliberately excludes key_hash.
const KEY_COLUMNS = "id, name, status, created_at, revoked_at, last_used_at";

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export class TursoApiKeyRepository implements IApiKeyRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(input: CreateApiKey, ctx: AuditContext): Promise<ApiKey> {
    const apiKey: ApiKey = {
      id: crypto.randomUUID(),
      name: input.name,
      status: "active",
      createdAt: nowIso(),
      revokedAt: null,
      lastUsedAt: null,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO api_keys (id, name, key_hash, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          apiKey.id,
          apiKey.name,
          input.keyHash,
          apiKey.status,
          apiKey.createdAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "api_key",
          entityId: apiKey.id,
          afterJson: JSON.stringify(apiKey),
        });
        return apiKey;
      });
    } catch (err) {
      translateConstraintError(err, `api key ${apiKey.name}`);
    }
  }

  async getById(id: string): Promise<ApiKey | null> {
    const stmt = await this.db.prepare(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ?`,
    );
    const row = await stmt.get(id) as ApiKeyRow | undefined;
    return row ? toApiKey(row) : null;
  }

  async findActiveByKeyHash(keyHash: string): Promise<ApiKey | null> {
    const stmt = await this.db.prepare(
      `SELECT ${KEY_COLUMNS} FROM api_keys
       WHERE key_hash = ? AND status = 'active'`,
    );
    const row = await stmt.get(keyHash) as ApiKeyRow | undefined;
    return row ? toApiKey(row) : null;
  }

  async list(page: PageRequest): Promise<Page<ApiKey>> {
    const countStmt = await this.db.prepare(
      "SELECT COUNT(*) AS total FROM api_keys",
    );
    const { total } = await countStmt.get() as { total: number };

    const listStmt = await this.db.prepare(
      `SELECT ${KEY_COLUMNS} FROM api_keys
       ORDER BY name, id LIMIT ? OFFSET ?`,
    );
    const rows = await listStmt.all(page.limit, page.offset) as ApiKeyRow[];

    return {
      items: rows.map(toApiKey),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async revoke(id: string, ctx: AuditContext): Promise<ApiKey> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("api_key", id);

    const revoked: ApiKey = {
      ...before,
      status: "revoked",
      revokedAt: before.revokedAt ?? nowIso(),
    };

    return await withTransaction(this.db, async () => {
      const stmt = await this.db.prepare(
        "UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?",
      );
      await stmt.run(revoked.revokedAt, id);
      await writeAuditEntry(this.db, {
        ...ctx,
        action: "status_change",
        entityType: "api_key",
        entityId: id,
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(revoked),
      });
      return revoked;
    });
  }

  async touchLastUsed(id: string, at: string): Promise<void> {
    const stmt = await this.db.prepare(
      "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
    );
    await stmt.run(at, id);
  }
}
