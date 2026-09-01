/**
 * Developer API middleware + response envelope, see docs/d6-block1.md
 * (D6-B, D6-C §55).
 *
 * Auth chain per request:
 *   Authorization header extraction (Bearer only — never query strings)
 *     → format validation (aegix_live_ prefix, length)
 *     → prefix lookup (indexed, ACTIVE only)
 *     → constant-time full-key hash verification
 *     → status + expiration check
 *     → scope check
 *     → developer identity + request context
 *
 * Response envelope (D6-B §32):
 *   success: { data, meta: { requestId, timestamp } }
 *   error:   { error: { code, message }, meta: { requestId } }
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Sql } from "@aegix/database";
import {
  createDeveloperApiKeyRepo,
  createDeveloperUsageRepo,
  developerKeyToView,
  type ApiKeyScope,
  type DeveloperApiKeyRow
} from "@aegix/database";
import type { AppConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";
import { API_KEY_PREFIX, API_KEY_PREFIX_LENGTH } from "@aegix/database";
import { verifyApiKey } from "./developer-keys.js";

export type DeveloperErrorCode =
  | "INVALID_API_KEY"
  | "REVOKED_API_KEY"
  | "INSUFFICIENT_SCOPE"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "INVALID_REQUEST"
  | "FEATURE_DISABLED"
  | "INTERNAL_ERROR";

export interface DeveloperContext {
  /** Verified developer identity — the owning product user (D6-C §30). */
  userId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
  scopes: ApiKeyScope[];
}

declare module "fastify" {
  interface FastifyRequest {
    /** Verified developer identity, set by developerAuth. */
    developer: DeveloperContext | null;
  }
}

export function developerError(reply: FastifyReply, code: DeveloperErrorCode, message: string, statusCode: number, requestId: string, meta?: Record<string, unknown>): FastifyReply {
  return reply.code(statusCode).send({
    error: { code, message },
    meta: { requestId, ...meta }
  });
}

export function developerSuccess<T>(reply: FastifyReply, data: T, requestId: string, meta?: Record<string, unknown>): FastifyReply {
  return reply.send({ data, meta: { requestId, timestamp: new Date().toISOString(), ...meta } });
}

/**
 * Rate/quota response headers (D6-D §80):
 * X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset apply to the
 * per-minute request velocity; X-Quota-Limit / X-Quota-Remaining /
 * X-Quota-Reset apply to the daily developer quota.
 */
export function setQuotaHeaders(reply: FastifyReply, quota: { limit: number; remaining: number; resetAt: string }, rate: { limit: number; remaining: number; resetAt: number | Date }): void {
  reply.header("x-ratelimit-limit", String(rate.limit));
  reply.header("x-ratelimit-remaining", String(Math.max(0, rate.remaining)));
  reply.header("x-ratelimit-reset", String(typeof rate.resetAt === "number" ? rate.resetAt : Math.floor(new Date(rate.resetAt).getTime() / 1000)));
  reply.header("x-quota-limit", String(quota.limit));
  reply.header("x-quota-remaining", String(Math.max(0, quota.remaining)));
  reply.header("x-quota-reset", String(Math.floor(new Date(quota.resetAt).getTime() / 1000)));
}

export interface DeveloperAuthDeps {
  sql: Sql;
  config: AppConfig;
  logger: AegixLogger;
}

export type DeveloperAuthResult =
  | { ok: true; developer: DeveloperContext; keyRow: DeveloperApiKeyRow }
  | { ok: false; code: DeveloperErrorCode; message: string; statusCode: number };

/** Extracts the Bearer token; rejects query-string secrets by design. */
function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function validateFormat(key: string): boolean {
  if (!key.startsWith(API_KEY_PREFIX)) return false;
  if (key.length < API_KEY_PREFIX.length + 16) return false;
  if (key.length > API_KEY_PREFIX.length + 64) return false;
  return true;
}

export function validateApiKeyFormat(key: string): boolean {
  return validateFormat(key);
}

export function createDeveloperAuth(deps: DeveloperAuthDeps) {
  const { sql, config, logger } = deps;
  const keyRepo = createDeveloperApiKeyRepo(sql);
  const usageRepo = createDeveloperUsageRepo(sql);

  return {
    async authenticate(req: FastifyRequest): Promise<DeveloperAuthResult> {
      const requestId = (req.headers["x-request-id"] as string | undefined) ?? "unknown";

      // 1. Extraction (D6-C §56): Bearer header only.
      const key = extractBearer(req);
      if (!key) {
        return { ok: false, code: "INVALID_API_KEY", message: "Missing or malformed Authorization header", statusCode: 401 };
      }

      // 2. Format validation (D6-C §55): recognizable versioned prefix.
      if (!validateFormat(key)) {
        return { ok: false, code: "INVALID_API_KEY", message: "Malformed API key", statusCode: 401 };
      }

      // 3. Prefix lookup (D6-C §55, §104): indexed — no scan. Auth looks up
      // any-status rows and verifies the hash FIRST; status/expiration are
      // checked after verification so a revoked/expired key reports
      // REVOKED_API_KEY and callers never learn whether a prefix exists.
      // The stored key_prefix column is API_KEY_PREFIX_LENGTH chars; the
      // lookup must use that same length (never a hard-coded 12).
      const prefix = key.slice(0, API_KEY_PREFIX_LENGTH);
      logger.debug("developer auth prefix", { requestId, apiKeyPrefix: `${prefix}…` });
      const row = await keyRepo.findByPrefix(prefix);
      if (!row) {
        logger.warn("developer auth failed: unknown prefix", { requestId, apiKeyPrefix: `${prefix}…` });
        return { ok: false, code: "INVALID_API_KEY", message: "Invalid API key", statusCode: 401 };
      }

      // 4. Constant-time hash verification (D6-C §42).
      if (!verifyApiKey(key, row.key_hash)) {
        logger.warn("developer auth failed: hash mismatch", { requestId, apiKeyPrefix: `${prefix}…` });
        return { ok: false, code: "INVALID_API_KEY", message: "Invalid API key", statusCode: 401 };
      }

      // 5. Status + expiration (D6-C §46, §49).
      if (row.status !== "ACTIVE") {
        return { ok: false, code: "REVOKED_API_KEY", message: "This API key has been revoked", statusCode: 401 };
      }
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return { ok: false, code: "REVOKED_API_KEY", message: "This API key has expired", statusCode: 401 };
      }

      // 6. Throttled last_used_at (D6-C §50): ≤1 write/key/minute.
      await keyRepo.touchUsed(row.id, new Date()).catch(() => {});

      const scopes = (row.scopes as ApiKeyScope[]) ?? [];
      return {
        ok: true,
        developer: { userId: row.user_id, apiKeyId: row.id, apiKeyPrefix: row.key_prefix, scopes },
        keyRow: row
      };
    },

    async requireScope(req: FastifyRequest, reply: FastifyReply, required: ApiKeyScope): Promise<DeveloperContext | null> {
      const authResult = await this.authenticate(req);
      if (!authResult.ok) {
        developerError(reply, authResult.code, authResult.message, authResult.statusCode, (req.headers["x-request-id"] as string) ?? "unknown");
        return null;
      }
      const { developer } = authResult;
      if (!developer.scopes.includes(required)) {
        const requestId = (req.headers["x-request-id"] as string) ?? "unknown";
        logger.warn("developer scope denied", { requestId, apiKeyPrefix: developer.apiKeyPrefix, requiredScope: required });
        developerError(reply, "INSUFFICIENT_SCOPE", `This API key lacks the required scope: ${required}`, 403, requestId);
        return null;
      }
      return developer;
    },

    /**
     * Atomically claims daily quota for the developer's user (D6-D §69-§70):
     * quota is per user, keys only attribute. Returns the post-claim summary.
     */
    async checkAndClaimQuota(developer: DeveloperContext, opts: { units?: number } = {}): Promise<{ allowed: boolean; summary: { limit: number; used: number; remaining: number; resetAt: string } }> {
      const now = new Date();

      // Atomic claim first (no read-then-write race, D6-D §70).
      const claimed = await usageRepo.tryClaim(developer.userId, opts.units ?? 1, config.DEVELOPER_DAILY_QUOTA, now);
      const summary = await usageRepo.summaryForUser(developer.userId, config.DEVELOPER_DAILY_QUOTA, now);
      return { allowed: claimed, summary };
    }
  };
}

export type DeveloperAuth = ReturnType<typeof createDeveloperAuth>;
