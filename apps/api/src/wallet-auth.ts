/**
 * Wallet-only authentication (D6-P), see docs/d6-block2.md.
 *
 * Challenge-response flow:
 *   POST /v1/auth/wallet/challenge  → server issues a nonce (hash stored)
 *   POST /v1/auth/wallet/verify     → Ed25519 signature over the exact
 *                                     message; atomic single-use consume;
 *                                     session issued (token hash stored).
 *
 * Security invariants (D6-P §12-§33):
 * - Nonce is 32 random bytes (node:crypto), only its SHA-256 digest is
 *   persisted — a DB compromise exposes no usable challenges (§14).
 * - Domain/URI come from trusted server configuration, never the client
 *   (§18-§19). The message contains the wallet, nonce, domain, uri,
 *   issued-at and expiry — modified bytes fail verification (§23).
 * - Consumption is atomic (`update ... where consumed_at is null
 *   returning`) — replay is impossible (§16).
 * - The session token is a random 32-byte secret; only its hash is stored
 *   (§28). Raw signatures never enter the session.
 * - First login is idempotent under concurrency via the partial unique
 *   index on profiles.primary_wallet + on-conflict bind (§26-§27).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { Sql } from "@aegix/database";
import {
  createSessionRepo,
  createWalletAuthRepo,
  type SessionRow
} from "@aegix/database";
import { decodeSolanaPublicKey, decodeSolanaSignature, isValidSolanaAddress } from "@aegix/blockchain";
import { ed25519 } from "@noble/curves/ed25519";

export const WALLET_AUTH_MESSAGE_VERSION = "aegix-wallet-auth-v1";

export type WalletAuthErrorCode =
  | "INVALID_WALLET"
  | "INVALID_SIGNATURE"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_CONSUMED"
  | "CHALLENGE_NOT_FOUND"
  | "CHALLENGE_LIMIT_REACHED"
  | "WALLET_MISMATCH"
  | "AUTH_DISABLED";

export interface WalletAuthDeps {
  sql: Sql;
  config: AppConfig;
}

export interface WalletSessionUser {
  id: string;
  wallet: string;
}

/**
 * Builds the deterministic, human-readable authentication message.
 * The exact bytes are what the wallet signs; never change the format
 * without bumping WALLET_AUTH_MESSAGE_VERSION.
 */
export function buildAuthMessage(input: {
  domain: string;
  wallet: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  statement: string;
  version: string;
}): string {
  return [
    "AEGIX authentication",
    "",
    `Domain: ${input.domain}`,
    `Wallet: ${input.wallet}`,
    `URI: ${input.uri}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expires At: ${input.expiresAt}`,
    "",
    input.statement,
    "",
    `Version: ${input.version}`
  ].join("\n");
}

/** SHA-256 hex digest. */
export function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * Normalizes a persisted timestamptz read-back to the exact ISO-8601
 * millisecond format that was embedded in the signed message at issue
 * time. The challenge row is written and read inside the same insert, so
 * the DB value is the source of truth for verification; this function
 * guarantees both sides agree byte-for-byte regardless of the driver's
 * timestamp formatting.
 */
export function canonicalIso(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface ChallengeResult {
  ok: true;
  challenge: {
    challengeId: string;
    message: string;
    nonce: string;
    domain: string;
    uri: string;
    version: string;
    issuedAt: string;
    expiresAt: string;
  };
}

export interface VerifyResult {
  ok: true;
  token: string;
  session: SessionRow;
  user: WalletSessionUser;
  isNewUser: boolean;
}

export type WalletAuthFailure = { ok: false; code: WalletAuthErrorCode; message: string; statusCode: number };

/** Resolves the owning user id for a wallet, or null when unknown. */
export async function resolveUserForWallet(sql: Sql, wallet: string): Promise<string | null> {
  const repo = createWalletAuthRepo(sql);
  return repo.userForWallet(wallet);
}

/**
 * Wallet challenge-response auth service. Pure orchestration over the
 * challenge/session repos + noble ed25519; no custom crypto.
 */
export function createWalletAuth(deps: WalletAuthDeps) {
  const { sql, config } = deps;
  const challengeRepo = createWalletAuthRepo(sql);
  const sessionRepo = createSessionRepo(sql);

  return {
    /** Issues a challenge bound to the trusted domain. The outstanding
     *  challenge cap is enforced here (D6-P §31-§32). */
    async issueChallenge(input: { wallet: string; ip: string }): Promise<ChallengeResult | WalletAuthFailure> {
      if (!isValidSolanaAddress(input.wallet)) {
        return { ok: false, code: "INVALID_WALLET", message: "Invalid Solana wallet address", statusCode: 400 };
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + config.WALLET_AUTH_CHALLENGE_TTL_SECONDS * 1000);
      const nonce = randomBytes(32).toString("base64url");
      const statement = "Sign in to AEGIX. This message does not create a blockchain transaction and does not cost SOL.";
      const domain = config.AUTH_DOMAIN;
      const uri = config.AUTH_APP_URI;
      const issuedAt = now.toISOString();
      const expiresAtIso = expiresAt.toISOString();
      const message = buildAuthMessage({
        domain,
        wallet: input.wallet,
        uri,
        nonce,
        issuedAt,
        expiresAt: expiresAtIso,
        statement,
        version: WALLET_AUTH_MESSAGE_VERSION
      });

      const row = await challengeRepo.insertChallenge({
        walletAddress: input.wallet,
        nonceHash: hashNonce(nonce),
        domain,
        uri,
        statement,
        version: WALLET_AUTH_MESSAGE_VERSION,
        expiresAt: expiresAtIso,
        // The exact issued-at the wallet signed: the persisted row must
        // carry the same millisecond, or verification rebuilds a different
        // message than the one the wallet signed.
        issuedAt,
        requestIpHash: input.ip ? hashIp(input.ip) : null,
        maxPendingPerWallet: config.WALLET_AUTH_MAX_PENDING_PER_WALLET
      });
      if (!row) {
        return { ok: false, code: "CHALLENGE_LIMIT_REACHED", message: "Too many pending challenges for this wallet — retry shortly", statusCode: 429 };
      }

      return {
        ok: true,
        challenge: {
          challengeId: row.id,
          message,
          nonce,
          domain,
          uri,
          version: WALLET_AUTH_MESSAGE_VERSION,
          issuedAt,
          expiresAt: expiresAtIso
        }
      };
    },

    /**
     * Verifies a signature and issues a session. The challenge is consumed
     * ATOMICALLY first — a second verification with the same challenge
     * fails even with a valid signature (replay, §16). The nonce comes
     * from the client (it was only ever shown once) and is checked against
     * the stored hash before the signed bytes are rebuilt (§14, §23).
     */
    async verify(input: {
      challengeId: string;
      wallet: string;
      signature: string;
      nonce: string;
    }): Promise<VerifyResult | WalletAuthFailure> {
      const challengeId = String(input.challengeId ?? "");
      if (!challengeId || !isValidSolanaAddress(input.wallet) || !input.signature || !input.nonce) {
        return { ok: false, code: "INVALID_SIGNATURE", message: "Malformed verification request", statusCode: 400 };
      }

      // Atomic single-use consumption BEFORE signature verification: the
      // challenge can only be used once regardless of signature validity
      // (prevents replay AND oracle probing of a challenge's validity).
      const challenge = await challengeRepo.consumeChallenge(challengeId);
      if (!challenge) {
        const existing = await challengeRepo.getChallengeById(challengeId);
        if (!existing) {
          return { ok: false, code: "CHALLENGE_NOT_FOUND", message: "Challenge not found", statusCode: 404 };
        }
        return { ok: false, code: "CHALLENGE_CONSUMED", message: "Challenge already used", statusCode: 400 };
      }

      // Expiry (after consume; the row is consumed either way).
      if (new Date(challenge.expires_at) < new Date()) {
        return { ok: false, code: "CHALLENGE_EXPIRED", message: "Challenge expired — request a new one", statusCode: 400 };
      }

      // Wallet binding: the signed message contains the claimed wallet, and
      // the public key used for verification IS that wallet (§20).
      if (challenge.wallet_address !== input.wallet) {
        return { ok: false, code: "WALLET_MISMATCH", message: "Wallet does not match the challenge", statusCode: 400 };
      }

      // Nonce: verify the client-supplied nonce matches the stored digest.
      // (The DB stores only the hash by design, §14.)
      if (!safeEqual(hashNonce(input.nonce), challenge.nonce_hash)) {
        return { ok: false, code: "INVALID_SIGNATURE", message: "Invalid nonce", statusCode: 400 };
      }

      // Ed25519 verification: public key = the wallet, message = exact
      // UTF-8 bytes, signature = base58-decoded 64 bytes (§22-§23).
      const publicKey = decodeSolanaPublicKey(challenge.wallet_address);
      const signature = decodeSolanaSignature(input.signature);
      if (!publicKey || !signature) {
        return { ok: false, code: "INVALID_SIGNATURE", message: "Malformed public key or signature", statusCode: 400 };
      }
      // Canonical timestamp fields: the message that was signed embeds the
      // issued/expiry ISO strings returned at issue time; the persisted
      // timestamps are read back with millisecond precision, so normalize
      // both sides to the same format before rebuilding the message.
      const canonicalIssued = canonicalIso(challenge.issued_at);
      const canonicalExpires = canonicalIso(challenge.expires_at);
      const message = buildAuthMessage({
        domain: challenge.domain,
        wallet: challenge.wallet_address,
        uri: challenge.uri,
        nonce: input.nonce,
        issuedAt: canonicalIssued,
        expiresAt: canonicalExpires,
        statement: challenge.statement,
        version: challenge.version
      });
      const valid = ed25519.verify(signature, new TextEncoder().encode(message), publicKey);
      if (!valid) {
        return { ok: false, code: "INVALID_SIGNATURE", message: "Signature verification failed", statusCode: 401 };
      }

      // Idempotent first login: bind the wallet to the owning user. The
      // partial unique index on profiles.primary_wallet + on-conflict make
      // concurrent first logins safe (§26-§27).
      const existingUserId = await challengeRepo.userForWallet(challenge.wallet_address);
      let userId = existingUserId;
      let isNewUser = false;
      if (!userId) {
        const profileId = randomUUID();
        const [profile] = await sql<Array<{ id: string }>>`
          insert into profiles (id, primary_wallet)
          values (${profileId}, ${challenge.wallet_address})
          on conflict (primary_wallet) where primary_wallet is not null do update set updated_at = now()
          returning id::text
        `;
        if (!profile) throw new Error("profile upsert returned no row");
        userId = profile.id;
        isNewUser = true;
        // Bind the wallet identity (idempotent).
        await challengeRepo.bindWallet(userId, challenge.wallet_address);
      } else {
        await challengeRepo.touchWallet(userId, challenge.wallet_address);
      }

      // Issue the session: random 32-byte token, hash-only at rest (§28).
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000).toISOString();
      const session = await sessionRepo.create({
        userId,
        tokenHash: hashToken(token),
        expiresAt
      });

      return { ok: true, token, session, user: { id: userId, wallet: challenge.wallet_address }, isNewUser };
    },

    /** Resolves a live session by bearer token (hash lookup). */
    async resolveSession(token: string): Promise<{ id: string; wallet: string } | null> {
      const session = await sessionRepo.findByTokenHash(hashToken(token));
      if (!session) return null;
      // Throttled last_used_at touch.
      await sessionRepo.touchUsed(session.id, new Date()).catch(() => {});
      // Resolve the wallet from the identity binding (primary).
      const [identity] = await sql<Array<{ wallet_address: string }>>`
        select wallet_address from user_wallet_identities
        where user_id = ${session.user_id} and is_primary = true
        limit 1
      `;
      return { id: session.user_id, wallet: identity?.wallet_address ?? "" };
    },

    /** Real session invalidation (§30). */
    async logout(token: string): Promise<boolean> {
      return sessionRepo.revoke(hashToken(token));
    }
  };
}

export type WalletAuth = ReturnType<typeof createWalletAuth>;
