// Session repository (auth PRD §4, Assumption 3). Login/logout audit as
// entity_type 'session' with the session row id — the token hash never
// appears in audit snapshots. Expiry is enforced by the AuthService; this
// class stores and harvests rows.
import type {
  AuditContext,
  CreateSession,
  ISessionRepository,
  Session,
} from "../interfaces/mod.ts";
import type { DatabaseConnection } from "./connection.ts";
import { writeAuditEntry } from "./audit.ts";
import {
  nowIso,
  translateConstraintError,
  withTransaction,
} from "./helpers.ts";

interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

// Audit snapshot: the domain Session (no token hash).
function snapshot(session: Session): string {
  return JSON.stringify(session);
}

export class TursoSessionRepository implements ISessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async create(input: CreateSession, ctx: AuditContext): Promise<Session> {
    const session: Session = {
      id: crypto.randomUUID(),
      userId: input.userId,
      createdAt: nowIso(),
      expiresAt: input.expiresAt,
    };

    try {
      return await withTransaction(this.db, async () => {
        const stmt = await this.db.prepare(
          `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        await stmt.run(
          session.id,
          input.tokenHash,
          session.userId,
          session.createdAt,
          session.expiresAt,
        );
        await writeAuditEntry(this.db, {
          ...ctx,
          action: "create",
          entityType: "session",
          entityId: session.id,
          afterJson: snapshot(session),
        });
        return session;
      });
    } catch (err) {
      translateConstraintError(err, `session for user ${input.userId}`);
    }
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const stmt = await this.db.prepare(
      "SELECT * FROM sessions WHERE token_hash = ?",
    );
    const row = await stmt.get(tokenHash) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async deleteByTokenHash(
    tokenHash: string,
    ctx: AuditContext,
  ): Promise<Session | null> {
    const session = await this.findByTokenHash(tokenHash);
    if (!session) return null;

    return await withTransaction(this.db, async () => {
      const stmt = await this.db.prepare(
        "DELETE FROM sessions WHERE token_hash = ?",
      );
      await stmt.run(tokenHash);
      await writeAuditEntry(this.db, {
        ...ctx,
        action: "delete",
        entityType: "session",
        entityId: session.id,
        beforeJson: snapshot(session),
      });
      return session;
    });
  }

  // Lazy harvest of past-expiry rows (not audited: system cleanup, not an
  // actor's action). Returns the number of rows removed.
  async deleteExpired(now: string): Promise<number> {
    const countStmt = await this.db.prepare(
      "SELECT COUNT(*) AS total FROM sessions WHERE expires_at <= ?",
    );
    const { total } = await countStmt.get(now) as { total: number };
    if (total > 0) {
      const stmt = await this.db.prepare(
        "DELETE FROM sessions WHERE expires_at <= ?",
      );
      await stmt.run(now);
    }
    return total;
  }
}
