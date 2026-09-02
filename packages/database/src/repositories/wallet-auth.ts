import type { Sql } from "../client.js";

export interface WalletAuthChallengeRow {
  id: string;
  wallet_address: string;
  nonce_hash: string;
  domain: string;
  uri: string;
  statement: string;
  version: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  request_ip_hash: string | null;
  created_at: string;
}

export interface UserWalletIdentityRow {
  id: string;
  user_id: string;
  wallet_address: string;
  is_primary: boolean;
  first_verified_at: string;
  last_used_at: string | null;
  created_at: string;
}

export interface WalletAuthRepo {
  /** Inserts a challenge; returns the row (null when the pending cap is hit). */
  insertChallenge(input: {
    walletAddress: string;
    nonceHash: string;
    domain: string;
    uri: string;
    statement: string;
    version: string;
    expiresAt: string;
    issuedAt?: string;
    requestIpHash: string | null;
    maxPendingPerWallet: number;
  }): Promise<WalletAuthChallengeRow | null>;
  getChallengeById(id: string): Promise<WalletAuthChallengeRow | null>;
  /** Atomic single-use consumption: only an unconsumed row can be consumed. */
  consumeChallenge(id: string): Promise<WalletAuthChallengeRow | null>;
  /** Purges expired (and optionally consumed) challenges opportunistically. */
  purgeExpired(now: string): Promise<void>;
  /** Binds a wallet to a user (idempotent). Returns the identity row. */
  bindWallet(userId: string, walletAddress: string): Promise<UserWalletIdentityRow>;
  /** Resolves the owning user for a wallet (existing account lookup). */
  userForWallet(walletAddress: string): Promise<string | null>;
  /** Updates last_used_at on the binding (throttled by the caller). */
  touchWallet(userId: string, walletAddress: string): Promise<void>;
}

/** Wallet challenge + identity repository, see docs/d6-block2.md (D6-P). */
export function createWalletAuthRepo(sql: Sql): WalletAuthRepo {
  return {
    async insertChallenge(input) {
      const nowIso = new Date().toISOString();
      // Pending cap check BEFORE insert (§31-§32): an unbounded attacker
      // must not be able to accumulate challenges. Count is over
      // unconsumed, unexpired challenges for this wallet.
      const [pending] = await sql<Array<{ count: string }>>`
        select count(*)::text as count from wallet_auth_challenges
        where wallet_address = ${input.walletAddress} and consumed_at is null
          and expires_at > now()
      `;
      if (pending && Number(pending.count) >= input.maxPendingPerWallet) {
        return null;
      }
      const [row] = await sql<WalletAuthChallengeRow[]>`
        insert into wallet_auth_challenges (
          wallet_address, nonce_hash, domain, uri, statement, version,
          expires_at, request_ip_hash, issued_at
        )
        values (
          ${input.walletAddress}, ${input.nonceHash}, ${input.domain}, ${input.uri},
          ${input.statement}, ${input.version}, ${input.expiresAt}, ${input.requestIpHash},
          ${input.issuedAt ?? nowIso}::timestamptz
        )
        on conflict (wallet_address, nonce_hash) do nothing
        returning id::text, wallet_address, nonce_hash, domain, uri, statement, version,
          ${input.issuedAt ?? nowIso} as issued_at,
          ${input.expiresAt} as expires_at,
          consumed_at, request_ip_hash, created_at
      `;
      return row ?? null;
    },

    async getChallengeById(id) {
      const [row] = await sql<WalletAuthChallengeRow[]>`
        select id::text, wallet_address, nonce_hash, domain, uri, statement, version,
          to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at,
          to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at,
          consumed_at, request_ip_hash, created_at
        from wallet_auth_challenges
        where id = ${id}
        limit 1
      `;
      return row ?? null;
    },

    async consumeChallenge(id) {
      const [row] = await sql<WalletAuthChallengeRow[]>`
        update wallet_auth_challenges
        set consumed_at = now()
        where id = ${id} and consumed_at is null
        returning id::text, wallet_address, nonce_hash, domain, uri, statement, version,
          to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at,
          to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at,
          consumed_at, request_ip_hash, created_at
      `;
      return row ?? null;
    },

    async purgeExpired(now) {
      await sql`
        delete from wallet_auth_challenges
        where expires_at < ${now}::timestamptz or consumed_at is not null
      `;
    },

    async bindWallet(userId, walletAddress) {
      const [row] = await sql<UserWalletIdentityRow[]>`
        insert into user_wallet_identities (user_id, wallet_address, is_primary)
        values (${userId}, ${walletAddress}, true)
        on conflict (user_id, wallet_address) do update set
          last_used_at = now()
        returning id::text, user_id::text, wallet_address, is_primary,
          first_verified_at, last_used_at, created_at
      `;
      if (!row) throw new Error("wallet identity bind returned no row");
      return row;
    },

    async userForWallet(walletAddress) {
      const [row] = await sql<Array<{ user_id: string }>>`
        select user_id::text from user_wallet_identities
        where wallet_address = ${walletAddress}
        order by is_primary desc, id asc
        limit 1
      `;
      return row?.user_id ?? null;
    },

    async touchWallet(userId, walletAddress) {
      await sql`
        update user_wallet_identities
        set last_used_at = now()
        where user_id = ${userId} and wallet_address = ${walletAddress}
      `;
    }
  };
}
