// User repository (auth PRD §4/§5). Mutations write their audit entries
// inside the same transaction (core PRD §3.4). The domain User never carries
// password_hash — the hash leaves this class only via getPasswordHash, and
// only to the identity provider; audit snapshots serialize the domain shape.
import {
  type AuditContext,
  type CreateUser,
  type IUserRepository,
  NotFoundError,
  type Page,
  type PageRequest,
  type UpdateUser,
  type User,
  type UserRole,
  type UserStatus,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  identity_provider: string;
  created_at: string;
  updated_at: string;
}

// SELECT list deliberately excludes password_hash.
const USER_COLUMNS =
  "id, username, display_name, role, status, identity_provider, created_at, updated_at";

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    identityProvider: row.identity_provider,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TursoUserRepository implements IUserRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(input: CreateUser, ctx: AuditContext): Promise<User> {
    const ts = nowIso();
    const user: User = {
      id: crypto.randomUUID(),
      username: input.username,
      displayName: input.displayName,
      role: input.role,
      status: "active",
      identityProvider: input.identityProvider ?? "local",
      createdAt: ts,
      updatedAt: ts,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO users (
             id, username, display_name, role, status, password_hash,
             identity_provider, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          user.id,
          user.username,
          user.displayName,
          user.role,
          user.status,
          input.passwordHash,
          user.identityProvider,
          user.createdAt,
          user.updatedAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "user",
          entityId: user.id,
          afterJson: JSON.stringify(user),
        });
        return user;
      });
    } catch (err) {
      translateConstraintError(err, `user ${user.username}`);
    }
  }

  async getById(id: string): Promise<User | null> {
    const stmt = await this.db.prepare(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
    );
    const row = await stmt.get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async getByUsername(username: string): Promise<User | null> {
    const stmt = await this.db.prepare(
      `SELECT ${USER_COLUMNS} FROM users WHERE username = ?`,
    );
    const row = await stmt.get(username) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    const stmt = await this.db.prepare(
      "SELECT password_hash FROM users WHERE id = ?",
    );
    const row = await stmt.get(userId) as
      | { password_hash: string | null }
      | undefined;
    return row?.password_hash ?? null;
  }

  async list(page: PageRequest): Promise<Page<User>> {
    const countStmt = await this.db.prepare(
      "SELECT COUNT(*) AS total FROM users",
    );
    const { total } = await countStmt.get() as { total: number };

    const listStmt = await this.db.prepare(
      `SELECT ${USER_COLUMNS} FROM users
       ORDER BY username, id LIMIT ? OFFSET ?`,
    );
    const rows = await listStmt.all(page.limit, page.offset) as UserRow[];

    return {
      items: rows.map(toUser),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async count(): Promise<number> {
    const stmt = await this.db.prepare("SELECT COUNT(*) AS total FROM users");
    const { total } = await stmt.get() as { total: number };
    return total;
  }

  async update(
    id: string,
    patch: UpdateUser,
    ctx: AuditContext,
  ): Promise<User> {
    const before = await this.getById(id);
    if (!before) throw new NotFoundError("user", id);

    const merged: User = {
      ...before,
      displayName: patch.displayName ?? before.displayName,
      role: patch.role ?? before.role,
      status: patch.status ?? before.status,
      updatedAt: nowIso(),
    };

    try {
      return await withTransaction(this.db, async () => {
        if (patch.passwordHash !== undefined) {
          const pwStmt = await this.db.prepare(
            "UPDATE users SET password_hash = ? WHERE id = ?",
          );
          await pwStmt.run(patch.passwordHash, id);
        }
        const stmt = await this.db.prepare(
          `UPDATE users SET
             display_name = ?, role = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        );
        await stmt.run(
          merged.displayName,
          merged.role,
          merged.status,
          merged.updatedAt,
          id,
        );
        // Disabling a user revokes access immediately: their sessions die in
        // the same transaction (auth PRD §3).
        if (merged.status === "disabled" && before.status === "active") {
          const killStmt = await this.db.prepare(
            "DELETE FROM sessions WHERE user_id = ?",
          );
          await killStmt.run(id);
        }
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "update",
          entityType: "user",
          entityId: id,
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(merged),
        });
        return merged;
      });
    } catch (err) {
      translateConstraintError(err, `user ${id}`);
    }
  }
}
