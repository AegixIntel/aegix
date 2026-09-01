import type { JsonValue, Sql, SqlTransaction } from "../client.js";

export const API_KEY_PREFIX = "aegix_live_";
/** Constant-time hash of the full plaintext key (D6-C §41). */
export const API_KEY_HASH_ALGORITHM = "sha256" as const;
/**
 * Length of the lookup prefix: static `aegix_live_` (10 chars) + 6 random
 * base58 chars = 17. This is what the `key_prefix` column stores and what
 * authentication slices from the presented key before the indexed lookup
 * (D6-C §55, §104).
 */
export const API_KEY_PREFIX_LENGTH = 17;

export type ApiKeyScope = "intelligence:read" | "usage:read";

export const KNOWN_API_KEY_SCOPES: readonly ApiKeyScope[] = ["intelligence:read", "usage:read"] as const;

export interface DeveloperApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: unknown;
  status: "ACTIVE" | "REVOKED";
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface DeveloperApiKeyView {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  status: "ACTIVE" | "REVOKED";
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface DeveloperApiKeyRepo {
  create(input: {
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: ApiKeyScope[];
    expiresAt: string | null;
  }): Promise<DeveloperApiKeyRow>;
  /**
   * Row for the auth lookup (D6-C §55): by prefix, any status. Auth itself
   * checks status/expiration AFTER hash verification so a revoked or expired
   * key yields REVOKED_API_KEY rather than a generic INVALID_API_KEY — never
   * reveal whether a prefix exists for unauthenticated callers.
   */
  findByPrefix(prefix: string): Promise<DeveloperApiKeyRow | null>;
  /** Active (non-revoked, non-expired) prefix lookup for non-auth callers. */
  findActiveByPrefix(prefix: string): Promise<DeveloperApiKeyRow | null>;
  listForUser(userId: string): Promise<DeveloperApiKeyRow[]>;
  getForUser(userId: string, id: string): Promise<DeveloperApiKeyRow | null>;
  /** Irreversible revoke (D6-C §46): row retained for usage attribution. */
  revokeForUser(userId: string, id: string): Promise<DeveloperApiKeyRow | null>;
  countActiveForUser(userId: string): Promise<number>;
  /** Throttled last_used_at update: at most one write per key per minute. */
  touchUsed(keyId: string, at: Date): Promise<void>;
}

function toView(row: DeveloperApiKeyRow): DeveloperApiKeyView {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: (row.scopes as ApiKeyScope[]) ?? [],
    status: row.status,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at
  };
}

/** Developer API key repository, see docs/d6-block1.md (D6-C). */
export function createDeveloperApiKeyRepo(sql: Sql | SqlTransaction): DeveloperApiKeyRepo {
  return {
    async create(input) {
      const [row] = await sql<DeveloperApiKeyRow[]>`
        insert into developer_api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at)
        values (${input.userId}, ${input.name}, ${input.keyPrefix}, ${input.keyHash}, ${sql.json(input.scopes as unknown as JsonValue)}, ${input.expiresAt})
        returning id::text, user_id::text, name, key_prefix, key_hash, scopes, status, created_at, last_used_at, expires_at, revoked_at
      `;
      if (!row) throw new Error("developer api key create returned no row");
      return row;
    },

    async findByPrefix(prefix) {
      const [row] = await sql<DeveloperApiKeyRow[]>`
        select id::text, user_id::text, name, key_prefix, key_hash, scopes, status, created_at, last_used_at, expires_at, revoked_at
        from developer_api_keys
        where key_prefix = ${prefix}
        limit 1
      `;
      return row ?? null;
    },

    async findActiveByPrefix(prefix) {
      const [row] = await sql<DeveloperApiKeyRow[]>`
        select id::text, user_id::text, name, key_prefix, key_hash, scopes, status, created_at, last_used_at, expires_at, revoked_at
        from developer_api_keys
        where key_prefix = ${prefix} and status = 'ACTIVE'
        limit 1
      `;
      return row ?? null;
    },

    async listForUser(userId) {
      return sql<DeveloperApiKeyRow[]>`
        select id::text, user_id::text, name, key_prefix, key_hash, scopes, status, created_at, last_used_at, expires_at, revoked_at
        from developer_api_keys
        where user_id = ${userId}
        order by created_at desc
      `;
    },

    async getForUser(userId, id) {
      const [row] = await sql<DeveloperApiKeyRow[]>`
        select id::text, user_id::text, name, key_prefix, key_hash, scopes, status, created_at, last_used_at, expires_at, revoked_at
        from developer_api_keys
        where user_id = ${userId} and id = ${id}
        limit 1
      `;
      return row ?? null;
    },

    async revokeForUser(userId, id) {
      const [row] = await sql<DeveloperApiKeyRow[]>`
        update developer_api_keys
        set status = 'REVOKED', revoked_at = now()
        where user_id = ${userId} and id = ${id} and status = 'ACTIVE'
        returning id::text, user_id::text, name, key_prefix, key_hash, scopes, status, created_at, last_used_at, expires_at, revoked_at
      `;
      return row ?? null;
    },

    async countActiveForUser(userId) {
      const [row] = await sql<Array<{ count: string }>>`
        select count(*)::text as count
        from developer_api_keys
        where user_id = ${userId} and status = 'ACTIVE'
          and (expires_at is null or expires_at > now())
      `;
      return row ? Number(row.count) : 0;
    },

    async touchUsed(keyId, at) {
      // Throttled: one write per key per minute (D6-C §50). The updated_at
      // guard makes concurrent requests within the window no-ops.
      const iso = at.toISOString();
      await sql`
        update developer_api_keys
        set last_used_at = ${iso}::timestamptz
        where id = ${keyId}
          and (last_used_at is null or last_used_at < ${iso}::timestamptz - interval '1 minute')
      `;
    }
  };
}

export { toView as developerKeyToView };
