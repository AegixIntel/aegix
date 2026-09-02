import type { Sql } from "../client.js";

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface SessionRepo {
  create(input: { userId: string; tokenHash: string; expiresAt: string }): Promise<SessionRow>;
  /** Resolves a live (unrevoked, unexpired) session by token hash. */
  findByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  /** Real revocation. Returns true when a live session was revoked. */
  revoke(tokenHash: string): Promise<boolean>;
  /** Throttled last_used_at touch: at most one write per session per minute. */
  touchUsed(sessionId: string, at: Date): Promise<void>;
}

/** Server-issued session repository, see docs/d6-block2.md (D6-P §28-§30). */
export function createSessionRepo(sql: Sql): SessionRepo {
  return {
    async create(input) {
      const [row] = await sql<SessionRow[]>`
        insert into sessions (user_id, token_hash, expires_at)
        values (${input.userId}, ${input.tokenHash}, ${input.expiresAt})
        returning id::text, user_id::text, token_hash, expires_at, revoked_at, created_at, last_used_at
      `;
      if (!row) throw new Error("session insert returned no row");
      return row;
    },

    async findByTokenHash(tokenHash) {
      const [row] = await sql<SessionRow[]>`
        select id::text, user_id::text, token_hash, expires_at, revoked_at, created_at, last_used_at
        from sessions
        where token_hash = ${tokenHash}
        limit 1
      `;
      if (!row) return null;
      if (row.revoked_at) return null;
      if (new Date(row.expires_at) < new Date()) return null;
      return row;
    },

    async revoke(tokenHash) {
      const result = await sql`
        update sessions
        set revoked_at = now()
        where token_hash = ${tokenHash} and revoked_at is null
      `;
      return result.count > 0;
    },

    async touchUsed(sessionId, at) {
      const iso = at.toISOString();
      await sql`
        update sessions
        set last_used_at = ${iso}::timestamptz
        where id = ${sessionId}
          and (last_used_at is null or last_used_at < ${iso}::timestamptz - interval '1 minute')
      `;
    }
  };
}
