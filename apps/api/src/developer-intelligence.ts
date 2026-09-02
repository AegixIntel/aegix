/**
 * Developer Intelligence API (D6-E), see docs/d6-block2.md.
 *
 * A THIN orchestration layer over the existing D1-D5 intelligence: wallet
 * x-ray, compare, analysis retrieval, comparison retrieval. No algorithm
 * forks. Auth/scopes/quota/rate-limit/admission/cache/dedup/metering ride
 * the D6 Block 1 developer rails (developerAuth.requireScope +
 * checkAndClaimQuota + recordDeveloperUsage).
 *
 * Reuse-first order (§57): fresh cache → persisted fresh analysis →
 * deduplicated existing job → new admitted work. Expensive new work is
 * async: 202 + poll URL, never request-blocking RPC crawling (§55-§56).
 */

import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { Sql } from "@aegix/database";
import { createAnalysisJobRepo, createWalletRepo, type AnalysisJobRow } from "@aegix/database";
import {
  classifyAddress,
  createProviderPoolFromConfig,
  isAnalysisEligible,
  isValidSolanaAddress
} from "@aegix/blockchain";
import type { AegixLogger } from "@aegix/logging";
import type { AegixQueues } from "@aegix/queue";
import { queueForPriority } from "@aegix/queue";
import { cachedComparison, canonicalComparePair, compareLockKey, loadFreshAnalysis, runComparison } from "./compare.js";
import type { DeveloperAuth } from "./developer-api.js";
import { developerError, developerSuccess } from "./developer-api.js";

const CACHE_PREFIX = "analysis-result";

export interface DeveloperIntelligenceDeps {
  app: FastifyInstance;
  sql: Sql;
  config: AppConfig;
  logger: AegixLogger;
  queues: AegixQueues;
  developerAuth: DeveloperAuth;
  /** Usage recorder compatible with the developer pipeline. */
  recordUsage: (input: {
    developer: { userId: string; apiKeyId: string } | null;
    requestId: string;
    operation: string;
    status: "SUCCESS" | "REJECTED";
    units?: number;
    cacheHit?: boolean;
    createdWork?: boolean;
    latencyMs?: number;
    scope?: string;
  }) => Promise<void>;
}

/** Account classification: reject non-wallet accounts with a structured
 *  error — never weaken the D3 classifier for API convenience (§49). */
async function classifyOrReject(deps: Pick<DeveloperIntelligenceDeps, "config" | "logger">, address: string, requestId: string): Promise<{ ok: true } | { ok: false; code: string; statusCode: number; message: string; accountType?: string }> {
  const provider = createProviderPoolFromConfig(deps.config);
  let classification;
  try {
    classification = await classifyAddress(provider, address);
  } catch {
    return { ok: false, code: "RPC_UNAVAILABLE", message: "Account classification unavailable right now", statusCode: 503 };
  }
  if (!isAnalysisEligible(classification.accountType)) {
    return {
      ok: false,
      code: "ACCOUNT_NOT_ANALYZABLE",
      statusCode: 422,
      message: `Address is a ${classification.accountType.toLowerCase()} and is not analyzed as a personal wallet`,
      accountType: classification.accountType
    };
  }
  return { ok: true };
}

/** Registers the developer intelligence routes on the app. */
export function registerDeveloperIntelligence(deps: DeveloperIntelligenceDeps): void {
  const { app, sql, config, logger, queues, developerAuth, recordUsage } = deps;
  const jobRepo = createAnalysisJobRepo(sql);
  const walletRepo = createWalletRepo(sql);
  const rateLimitConfig = { max: config.DEVELOPER_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" as const };

  const gate = (reply: Parameters<typeof developerError>[0] extends never ? never : Parameters<typeof developerError>[0]): ReturnType<typeof developerError> | null => {
    if (!config.ENABLE_DEVELOPER_INTELLIGENCE_API) {
      return developerError(reply, "FEATURE_DISABLED", "The developer intelligence API is currently disabled", 403, (reply.request?.headers["x-request-id"] as string) ?? "unknown");
    }
    return null;
  };

  // ---- POST /v1/developer/intelligence/wallet ----
  app.post<{ Body: { wallet: string } }>(
    "/v1/developer/intelligence/wallet",
    {
      config: { rateLimit: rateLimitConfig },
      schema: {
        body: {
          type: "object",
          required: ["wallet"],
          properties: { wallet: { type: "string", minLength: 32, maxLength: 44 } }
        }
      }
    },
    async (req, reply) => {
      const requestId = (req.headers["x-request-id"] as string) ?? "unknown";
      const started = Date.now();
      const g = gate(reply);
      if (g) return g;
      const developer = await developerAuth.requireScope(req, reply, "intelligence:read");
      if (!developer) return;
      const { wallet } = req.body;
      if (!isValidSolanaAddress(wallet)) {
        await recordUsage({ developer, requestId, operation: "intelligence.wallet", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "INVALID_REQUEST", "Invalid Solana wallet address", 400, requestId);
      }

      const classification = await classifyOrReject({ config, logger }, wallet, requestId);
      if (!classification.ok) {
        await recordUsage({ developer, requestId, operation: "intelligence.wallet", status: "REJECTED", latencyMs: Date.now() - started, scope: classification.accountType });
        return developerError(reply, classification.code as never, classification.message, classification.statusCode, requestId);
      }

      // Quota claim (atomic) before work; cache hits still cost 1 unit but
      // are marked cacheHit (no duplicate charge for deduped jobs, §60).
      const quota = await developerAuth.checkAndClaimQuota(developer, { units: config.DEVELOPER_INTELLIGENCE_QUOTA_UNITS_WALLET });
      if (!quota.allowed) {
        await recordUsage({ developer, requestId, operation: "intelligence.wallet", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "QUOTA_EXCEEDED", `Daily developer quota exceeded (limit ${quota.summary.limit})`, 429, requestId);
      }

      // 1. Fresh cache.
      const cache = (await import("@aegix/cache")).createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
      try {
        const cached = await cache.getJson<{ analysisId: string }>(`${CACHE_PREFIX}:${wallet}`);
        if (cached?.analysisId) {
          const status = await jobStatusFor(jobRepo, cached.analysisId);
          await recordUsage({ developer, requestId, operation: "intelligence.wallet", status: "SUCCESS", cacheHit: true, latencyMs: Date.now() - started });
          logger.info("developer intelligence wallet cache hit", { requestId, apiKeyId: developer.apiKeyId, walletShort: wallet.slice(0, 6), analysisId: cached.analysisId });
          return developerSuccess(reply, { analysisId: cached.analysisId, status: status?.status ?? "READY", cached: true }, requestId);
        }

        // 2. Fresh READY persisted analysis → backfill cache.
        const walletRow = await walletRepo.findByAddress("solana", wallet);
        if (walletRow) {
          const latest = await jobRepo.latestForWallet(walletRow.id);
          if (latest && latest.status === "READY" && latest.fresh_until && new Date(latest.fresh_until) > new Date()) {
            await cache.setJson(`${CACHE_PREFIX}:${wallet}`, { analysisId: latest.id }, config.ANALYSIS_CACHE_TTL_SECONDS);
            await recordUsage({ developer, requestId, operation: "intelligence.wallet", status: "SUCCESS", cacheHit: true, latencyMs: Date.now() - started });
            return developerSuccess(reply, { analysisId: latest.id, status: "READY", cached: true }, requestId);
          }
        }

        // 3. Admission control before creating an expensive job (§56).
        const admission = await checkAdmission({ queues, sql, config, userId: developer.userId, ip: req.ip });
        if (!admission.admitted) {
          await recordUsage({ developer, requestId, operation: "intelligence.wallet", status: "REJECTED", latencyMs: Date.now() - started });
          return developerError(reply, "SERVICE_BUSY", String(admission.body.message ?? "System is at capacity"), 503, requestId);
        }

        // 4. Create + enqueue (deterministic jobId → dedup, §59).
        const walletRow2 = walletRow ?? (await walletRepo.findOrCreate("solana", wallet));
        const job = await jobRepo.create({ walletId: walletRow2.id, requestedBy: developer.userId, analysisType: "full", priority: "standard" });
        const queue = queueForPriority(job.priority, queues);
        await queue.add("analyze", { analysisId: job.id, walletAddress: wallet, chain: "solana", analysisType: "full" }, { jobId: `analysis-${job.id}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } });
        await cache.setJson(`${CACHE_PREFIX}:${wallet}`, { analysisId: job.id }, config.ANALYSIS_CACHE_TTL_SECONDS);

        await recordUsage({ developer, requestId, operation: "intelligence.wallet", status: "SUCCESS", createdWork: true, latencyMs: Date.now() - started });
        logger.info("developer intelligence wallet job created", { requestId, apiKeyId: developer.apiKeyId, walletShort: wallet.slice(0, 6), analysisId: job.id });
        return reply.code(202).send({
          data: { analysisId: job.id, status: job.status, pollUrl: `/v1/developer/intelligence/analysis/${job.id}` },
          meta: { requestId, timestamp: new Date().toISOString() }
        });
      } finally {
        await cache.close();
      }
    }
  );

  // ---- POST /v1/developer/intelligence/compare ----
  app.post<{ Body: { walletA: string; walletB: string } }>(
    "/v1/developer/intelligence/compare",
    {
      config: { rateLimit: rateLimitConfig },
      schema: {
        body: {
          type: "object",
          required: ["walletA", "walletB"],
          properties: {
            walletA: { type: "string", minLength: 32, maxLength: 44 },
            walletB: { type: "string", minLength: 32, maxLength: 44 }
          }
        }
      }
    },
    async (req, reply) => {
      const requestId = (req.headers["x-request-id"] as string) ?? "unknown";
      const started = Date.now();
      const g = gate(reply);
      if (g) return g;
      const developer = await developerAuth.requireScope(req, reply, "intelligence:read");
      if (!developer) return;
      const { walletA, walletB } = req.body;
      if (!isValidSolanaAddress(walletA) || !isValidSolanaAddress(walletB)) {
        await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "INVALID_REQUEST", "Invalid Solana wallet address", 400, requestId);
      }
      if (walletA === walletB) {
        await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "INVALID_REQUEST", "Cannot compare a wallet with itself", 400, requestId);
      }
      // Kill switches (D5-L §94): compare depends on D5 intelligence.
      if (!config.ENABLE_CORRELATION_ANALYSIS || !config.ENABLE_MULTI_HOP_GRAPH) {
        return developerError(reply, "FEATURE_DISABLED", "Wallet comparison is currently disabled", 403, requestId);
      }
      for (const address of [walletA, walletB]) {
        const classification = await classifyOrReject({ config, logger }, address, requestId);
        if (!classification.ok) {
          await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "REJECTED", latencyMs: Date.now() - started, scope: classification.accountType });
          return developerError(reply, "ACCOUNT_NOT_COMPARABLE", classification.message, 422, requestId);
        }
      }

      const quota = await developerAuth.checkAndClaimQuota(developer, { units: config.DEVELOPER_INTELLIGENCE_QUOTA_UNITS_COMPARE });
      if (!quota.allowed) {
        await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "QUOTA_EXCEEDED", `Daily developer quota exceeded (limit ${quota.summary.limit})`, 429, requestId);
      }

      const pairId = canonicalComparePair(walletA, walletB);

      // 1. Canonical cache: (A,B) == (B,A) (§58).
      const cacheHit = await cachedComparison({ sql, config }, pairId);
      if (cacheHit) {
        await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "SUCCESS", cacheHit: true, latencyMs: Date.now() - started });
        return developerSuccess(reply, { ...stripSensitive(cacheHit), cached: true }, requestId);
      }

      // 2. Distributed dedup lock: 10 identical requests → one compute (§59).
      const cache = (await import("@aegix/cache")).createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
      try {
        const lockAcquired = await cache.acquireLock(compareLockKey(pairId), 120);
        if (!lockAcquired) {
          const existing = await cachedComparison({ sql, config }, pairId);
          if (existing) {
            await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "SUCCESS", cacheHit: true, latencyMs: Date.now() - started });
            return developerSuccess(reply, { ...stripSensitive(existing), cached: true }, requestId);
          }
          await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "REJECTED", latencyMs: Date.now() - started });
          return developerError(reply, "COMPARISON_IN_PROGRESS", "This comparison is already being computed", 409, requestId);
        }
        try {
          // 3. Reuse-first: both wallets need fresh READY analyses.
          const [freshA, freshB] = await Promise.all([loadFreshAnalysis({ sql, config }, walletA), loadFreshAnalysis({ sql, config }, walletB)]);
          if (!freshA || !freshB) {
            const missing = !freshA ? walletA : walletB;
            await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "REJECTED", latencyMs: Date.now() - started });
            return developerError(reply, "ANALYSIS_REQUIRED", `No fresh analysis available for ${missing.slice(0, 6)}… — analyze it first`, 422, requestId);
          }
          const result = await runComparison({ sql, config }, { walletA, walletB });
          await cache.setJson((await import("./compare.js")).compareCacheKey(pairId), result, config.CORRELATION_CACHE_TTL_SECONDS);
          await recordUsage({ developer, requestId, operation: "intelligence.compare", status: "SUCCESS", latencyMs: Date.now() - started });
          logger.info("developer intelligence compare complete", {
            requestId, apiKeyId: developer.apiKeyId, pairId,
            correlationScore: result.correlation.correlationScore,
            analysisA: freshA.job.id, analysisB: freshB.job.id,
            paths: result.relationshipPaths.length, clusters: result.clusters.length
          });
          return developerSuccess(reply, stripSensitive(result), requestId);
        } finally {
          await cache.releaseLock(compareLockKey(pairId));
        }
      } finally {
        await cache.close();
      }
    }
  );

  // ---- GET /v1/developer/intelligence/analysis/:id ----
  app.get<{ Params: { id: string } }>(
    "/v1/developer/intelligence/analysis/:id",
    {
      config: { rateLimit: rateLimitConfig },
      schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } }
    },
    async (req, reply) => {
      const requestId = (req.headers["x-request-id"] as string) ?? "unknown";
      const started = Date.now();
      const g = gate(reply);
      if (g) return g;
      const developer = await developerAuth.requireScope(req, reply, "intelligence:read");
      if (!developer) return;
      const job = await jobRepo.findById(req.params.id);
      if (!job) {
        await recordUsage({ developer, requestId, operation: "intelligence.analysis.read", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "NOT_FOUND", "Analysis not found", 404, requestId);
      }
      const wallet = await walletRepo.findById(job.wallet_id);
      await recordUsage({ developer, requestId, operation: "intelligence.analysis.read", status: "SUCCESS", cacheHit: job.status === "READY", latencyMs: Date.now() - started });
      return developerSuccess(
        reply,
        {
          analysisId: job.id,
          wallet: wallet?.address ?? null,
          status: job.status,
          progress: job.progress,
          engineVersion: job.engine_version,
          createdAt: job.requested_at,
          completedAt: job.completed_at,
          freshUntil: job.fresh_until,
          failureCode: job.failure_code
        },
        requestId
      );
    }
  );

  // ---- GET /v1/developer/intelligence/comparison/:pairId ----
  app.get<{ Params: { pairId: string } }>(
    "/v1/developer/intelligence/comparison/:pairId",
    {
      config: { rateLimit: rateLimitConfig },
      schema: { params: { type: "object", required: ["pairId"], properties: { pairId: { type: "string" } } } }
    },
    async (req, reply) => {
      const requestId = (req.headers["x-request-id"] as string) ?? "unknown";
      const started = Date.now();
      const g = gate(reply);
      if (g) return g;
      const developer = await developerAuth.requireScope(req, reply, "intelligence:read");
      if (!developer) return;
      const { pairId } = req.params;
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}\|[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pairId)) {
        await recordUsage({ developer, requestId, operation: "intelligence.comparison.read", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "INVALID_REQUEST", "Invalid comparison pair id", 400, requestId);
      }
      const hit = await cachedComparison({ sql, config }, pairId);
      if (!hit) {
        await recordUsage({ developer, requestId, operation: "intelligence.comparison.read", status: "REJECTED", latencyMs: Date.now() - started });
        return developerError(reply, "NOT_FOUND", "Comparison not found — run a compare first", 404, requestId);
      }
      await recordUsage({ developer, requestId, operation: "intelligence.comparison.read", status: "SUCCESS", cacheHit: true, latencyMs: Date.now() - started });
      return developerSuccess(reply, stripSensitive(hit), requestId);
    }
  );
}

/** Language safety (§52): never expose ownership/identity fields. */
function stripSensitive<T extends object>(result: T): T {
  const { sameOwner, identity, person, ...rest } = result as T & { sameOwner?: unknown; identity?: unknown; person?: unknown };
  return rest as T;
}

async function jobStatusFor(jobRepo: ReturnType<typeof createAnalysisJobRepo>, analysisId: string): Promise<AnalysisJobRow | null> {
  return jobRepo.findById(analysisId);
}

async function checkAdmission(deps: {
  queues: AegixQueues;
  sql: Sql;
  config: AppConfig;
  userId: string;
  ip: string;
}): Promise<{ admitted: true } | { admitted: false; body: Record<string, unknown> }> {
  const { queues, sql, config, userId } = deps;
  if (!config.ENABLE_NEW_ANALYSES) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "New analyses are temporarily disabled" } };
  }
  const [standard, high, free] = await Promise.all([
    queues.analysisStandard.getJobCounts(),
    queues.analysisHigh.getJobCounts(),
    queues.analysisFree.getJobCounts()
  ]);
  const totalQueued = (standard.waiting ?? 0) + (standard.delayed ?? 0) + (high.waiting ?? 0) + (high.delayed ?? 0) + (free.waiting ?? 0) + (free.delayed ?? 0);
  const totalActive = (standard.active ?? 0) + (high.active ?? 0) + (free.active ?? 0);
  if (totalQueued >= config.MAX_QUEUE_DEPTH) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "Analysis queue is full, try again later" } };
  }
  if (totalActive >= config.MAX_ACTIVE_GLOBAL) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "System is at capacity, try again later" } };
  }
  const [pending] = await sql<Array<{ count: string }>>`
    select count(*)::text as count from analysis_jobs
    where status not in ('READY', 'FAILED', 'CANCELLED') and requested_by = ${userId}
  `;
  if (pending && Number(pending.count) >= config.MAX_PENDING_PER_USER) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "Too many pending analyses, wait for them to finish" } };
  }
  return { admitted: true };
}
