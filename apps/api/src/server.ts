import { randomUUID, createHash } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import type { AppConfig } from "@aegix/config";
import {
  classifyAddress,
  createProviderPoolFromConfig,
  isAnalysisEligible,
  isValidSolanaAddress,
  type AccountClassification,
  type BlockchainProvider
} from "@aegix/blockchain";
import { createLogger, walletRef } from "@aegix/logging";
import {
  createAnalysisJobRepo,
  createCorrelationRepo,
  createDb,
  createDeveloperApiKeyRepo,
  createDeveloperUsageRepo,
  createExposureDiffRepo,
  createIntelligenceRepo,
  createMonitorAlertRulesRepo,
  createMonitorCheckRepo,
  createMonitorRepo,
  createMonitorCorrelationRepo,
  createNotificationRepo,
  createSavedAnalysisRepo,
  createSavedComparisonRepo,
  createThreatEventRepo,
  createWalletRepo,
  developerKeyToView,
  KNOWN_API_KEY_SCOPES,
  type AnalysisJobRow,
  type ApiKeyScope,
  type DeveloperApiKeyView,
  type ScoreRow,
  type SignalRow
} from "@aegix/database";
import { createCache } from "@aegix/cache";
import { createQueues, queueForPriority } from "@aegix/queue";
import { explainPath, explainSignal } from "@aegix/explanation";
import { buildWalletContext, type WalletContextProfile } from "@aegix/context";
import { createOpenAICompatibleProvider } from "@aegix/ai";
import type { FeatureKey } from "@aegix/billing";
import { createBillingRepo } from "@aegix/database";
import { createEntitlementService } from "./entitlements.js";
import { registerBilling } from "./billing.js";
import { paymentProviderFromConfig } from "./billing-paddle.js";
import { registerAskAegix } from "./ask-aegix.js";
import { claimDailyUsage } from "./metered-quota.js";
import { createCoinPaprikaProvider, createMarketService, type MarketDataProvider } from "@aegix/markets";
import { registerMarkets } from "./markets.js";
import { loadContextSupporting } from "./context-supporting.js";
import { createAuth, requireUser, type AuthUser } from "./auth.js";
import { createWalletAuth, WALLET_AUTH_MESSAGE_VERSION } from "./wallet-auth.js";
import { checkQuota, recordCacheHit, recordQuotaUsage, type QuotaContext } from "./quota.js";
import { cachedComparison, canonicalComparePair, compareCacheKey, compareLockKey, loadFreshAnalysis, runComparison, type CompareResult } from "./compare.js";
import { createDeveloperAuth, developerError, developerSuccess, setQuotaHeaders } from "./developer-api.js";
import { generateApiKey } from "./developer-keys.js";
import { registerDeveloperIntelligence } from "./developer-intelligence.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerNotificationEmailRoutes } from "./notification-email.js";
import { decodeNotificationCursor } from "./notification-cursor.js";
import { ANALYSIS_PIPELINE_VERSION } from "@aegix/types";
import type { IntelligenceSignal } from "@aegix/types";

export interface ApiDeps {
  config: AppConfig;
  provider?: BlockchainProvider;
  marketProvider?: MarketDataProvider;
  /** Outbound HTTP for the payment processor; tests substitute a fake processor. */
  billingFetch?: typeof fetch;
}

const ENGINE_SCOPE = "full";
const CACHE_PREFIX = "analysis-result";

function analysisLockKey(address: string, engineVersion: string): string {
  return `analysis-lock:solana:${address}:${ENGINE_SCOPE}:${engineVersion}`;
}

/** Builds the quota context for a request, see D3-F. */
function quotaContext(req: FastifyRequest): QuotaContext {
  const user = req.user;
  return {
    userId: user && !user.isAnonymous ? user.id : null,
    anonymousKey: (req.headers["x-anonymous-id"] as string | undefined) ?? null,
    ip: req.ip
  };
}

/**
 * Admission control, see D3-C §25-§26: checks system capacity before
 * accepting an expensive analysis job. Returns null when the request may
 * proceed, or a SERVICE_BUSY response body when overloaded.
 */
async function checkAdmission(deps: {
  queues: ReturnType<typeof createQueues>;
  sql: ReturnType<typeof createDb>;
  config: AppConfig;
  userId: string | null;
  ip: string;
}): Promise<{ admitted: true } | { admitted: false; body: Record<string, unknown> }> {
  const { queues, sql, config, userId, ip } = deps;

  // Kill switch: new analyses can be disabled without touching cached reports.
  if (!config.ENABLE_NEW_ANALYSES) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "New analyses are temporarily disabled", requestId: randomUUID() } };
  }

  const [standard, high, free] = await Promise.all([
    queues.analysisStandard.getJobCounts(),
    queues.analysisHigh.getJobCounts(),
    queues.analysisFree.getJobCounts()
  ]);
  const totalQueued =
    (standard.waiting ?? 0) + (standard.delayed ?? 0) +
    (high.waiting ?? 0) + (high.delayed ?? 0) +
    (free.waiting ?? 0) + (free.delayed ?? 0);
  const totalActive = (standard.active ?? 0) + (high.active ?? 0) + (free.active ?? 0);

  if (totalQueued >= config.MAX_QUEUE_DEPTH) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "Analysis queue is full, try again later", requestId: randomUUID() } };
  }
  if (totalActive >= config.MAX_ACTIVE_GLOBAL) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "System is at capacity, try again later", requestId: randomUUID() } };
  }

  // Per-actor pending limits: count non-terminal jobs for this user or IP.
  const pendingWhere = userId
    ? sql`requested_by = ${userId}`
    : sql`requested_by is null and requested_at > now() - interval '24 hours' and ip_address = ${ip}`;
  const [pending] = await sql<Array<{ count: string }>>`
    select count(*)::text as count from analysis_jobs
    where status not in ('READY', 'FAILED', 'CANCELLED') and ${pendingWhere}
  `;
  const limit = userId ? config.MAX_PENDING_PER_USER : config.MAX_PENDING_PER_IP;
  if (pending && Number(pending.count) >= limit) {
    return { admitted: false, body: { code: "SERVICE_BUSY", message: "Too many pending analyses, wait for them to finish", requestId: randomUUID() } };
  }

  return { admitted: true };
}

export async function buildServer(deps: ApiDeps) {
  const { config } = deps;
  // Request logging is handled by the redacting AEGIX logger below. Fastify's
  // default logger includes the raw query string and can leak API keys/URLs.
  // Trusting a fixed number of hops resolves req.ip from the rightmost
  // untrusted X-Forwarded-For entry, so a client cannot spoof its IP by
  // sending the header itself. Without it, req.ip behind nginx is the proxy
  // for everyone. (Fastify accepts a numeric hop count at runtime, but its
  // typings only admit this equivalent predicate.)
  const trustedHops = config.TRUST_PROXY_HOPS;
  const app = Fastify({
    logger: false,
    bodyLimit: config.API_BODY_LIMIT_BYTES,
    trustProxy: trustedHops > 0 ? (_address: string, hop: number) => hop < trustedHops : false
  });
  const logger = createLogger(config, { service: "api" });

  // D6-J §65: production error responses never expose stack traces, SQL,
  // internal hostnames or filesystem paths. Unexpected errors return a
  // generic envelope; the detail goes to the server log only.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? "unknown";
    if (err.statusCode && err.statusCode < 500) {
      // Validation / 4xx errors carry safe messages from route schemas.
      const message = err.message ?? "Invalid request";
      return reply.code(err.statusCode).send({ error: { code: "INVALID_REQUEST", message }, meta: { requestId } });
    }
    logger.error("unhandled request error", {
      requestId,
      method: req.method,
      path: req.routeOptions?.url ?? req.url,
      error: err.message,
      stack: config.NODE_ENV === "production" ? undefined : err.stack
    });
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" }, meta: { requestId } });
  });

  await app.register(cors, { origin: config.CORS_ORIGIN.split(",") });
  // Global baseline rate limit; per-route limits below override it, see D3-I §50-§51.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute"
  });

  const sql = createDb(config.DATABASE_URL);
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const savedRepo = createSavedAnalysisRepo(sql);
  const savedComparisonRepo = createSavedComparisonRepo(sql);
  const developerKeyRepo = createDeveloperApiKeyRepo(sql);
  const developerUsageRepo = createDeveloperUsageRepo(sql);
  const correlationRepo = createCorrelationRepo(sql);
  const monitorRepo = createMonitorRepo(sql);
  const monitorCheckRepo = createMonitorCheckRepo(sql);
  const diffRepo = createExposureDiffRepo(sql);
  const threatEventRepo = createThreatEventRepo(sql);
  const alertRulesRepo = createMonitorAlertRulesRepo(sql);
  const notificationRepo = createNotificationRepo(sql);
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  const queues = createQueues(config);
  const provider = deps.provider ?? createProviderPoolFromConfig(config);
  const billingRepo = createBillingRepo(sql);
  // D11: every plan-controlled limit below is read from here. The free plan
  // is built from the same config values these enforcement points used
  // before, so an identity without a subscription sees no change.
  const entitlements = createEntitlementService({ config, repo: billingRepo, logger });
  // D11: surfaces without a quota still ask the entitlement layer whether the
  // identity's plan includes them, so plan logic never lives in route code.
  // Every v1 plan includes every feature, so this refuses nothing today.
  const featureGate = async (reply: FastifyReply, userId: string, feature: FeatureKey) => {
    if (await entitlements.canUseFeature(userId, feature)) return null;
    return reply.code(403).send({ code: "FEATURE_NOT_IN_PLAN", message: "Your plan does not include this feature", requestId: randomUUID() });
  };
  const paymentProvider = paymentProviderFromConfig(config, deps.billingFetch);
  const developerAuth = createDeveloperAuth({
    sql,
    config,
    logger,
    quotaFor: (userId) => entitlements.limit(userId, "api.daily")
  });

  // Analysis trace, see D2 §56: every API request carries a request_id that
  // flows into job records. Full wallet addresses are never logged.
  const auth = createAuth(config);
  const walletAuth = createWalletAuth({ sql, config });
  app.addHook("onRequest", async (req) => {
    const requestId = randomUUID();
    req.headers["x-request-id"] = requestId;
    const address = (req.params as { address?: string })?.address ?? (req.body as { address?: string } | null)?.address;
    const ctx = { requestId, method: req.method, path: req.routeOptions?.url ?? req.url, ...(address ? walletRef(address) : {}) };
    logger.info("request started", ctx);
    // Server-side auth resolution, see D3-D §29: never trust frontend claims.
    // Wallet sessions first (D6-P); Supabase JWT is a temporary legacy
    // bridge for pre-wallet identities, gated by ENABLE_LEGACY_AUTH (§35).
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      if (token) {
        const sessionUser = await walletAuth.resolveSession(token);
        if (sessionUser) {
          req.user = { id: sessionUser.id, email: null, isAnonymous: false, wallet: sessionUser.wallet };
          return;
        }
      }
    }
    if (config.ENABLE_LEGACY_AUTH) {
      req.user = await auth.resolveUser(req);
    } else {
      req.user = null;
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? "unknown";
    const address = (req.params as { address?: string })?.address ?? (req.body as { address?: string } | null)?.address;
    const ctx = { requestId, method: req.method, statusCode: reply.statusCode, durationMs: reply.elapsedTime, ...(address ? walletRef(address) : {}) };
    logger.info("request completed", ctx);
  });

  // Security headers, see architecture.md §80: CSP allows only same-origin
  // scripts/styles (the Next.js frontend has no inline scripts or external
  // CDNs), plus nosniff / frame deny / referrer policy.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false,
    xFrameOptions: { action: "deny" }
  });

  app.addHook("onClose", async () => {
    await queues.close();
    await cache.close();
    await sql.end();
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  // ---- D6-P: wallet-only authentication (challenge-response, signMessage) ----
  // No email/password/magic-link/OAuth login exists anywhere in the product.

  app.post<{ Body: { wallet: string } }>(
    "/v1/auth/wallet/challenge",
    {
      config: {
        rateLimit: { max: config.WALLET_AUTH_RATE_LIMIT_CHALLENGE, timeWindow: "1 minute" }
      },
      schema: {
        body: {
          type: "object",
          required: ["wallet"],
          properties: { wallet: { type: "string", minLength: 32, maxLength: 44 } }
        }
      }
    },
    async (req, reply) => {
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
      const started = Date.now();
      const result = await walletAuth.issueChallenge({ wallet: req.body.wallet, ip: req.ip });
      if (!result.ok) {
        logger.warn("wallet auth challenge rejected", {
          requestId,
          walletHash: hashWalletForLog(req.body.wallet),
          authResult: result.code,
          durationMs: Date.now() - started
        });
        return reply.code(result.statusCode).send({ error: { code: result.code, message: result.message }, meta: { requestId } });
      }
      logger.info("wallet auth challenge issued", {
        requestId,
        authChallengeId: result.challenge.challengeId,
        walletHash: hashWalletForLog(req.body.wallet),
        durationMs: Date.now() - started
      });
      return reply.send({ data: result.challenge, meta: { requestId } });
    }
  );

  app.post<{ Body: { challengeId: string; wallet: string; signature: string; nonce: string } }>(
    "/v1/auth/wallet/verify",
    {
      config: {
        rateLimit: { max: config.WALLET_AUTH_RATE_LIMIT_VERIFY, timeWindow: "1 minute" }
      },
      schema: {
        body: {
          type: "object",
          required: ["challengeId", "wallet", "signature", "nonce"],
          properties: {
            challengeId: { type: "string" },
            wallet: { type: "string", minLength: 32, maxLength: 44 },
            signature: { type: "string", minLength: 64, maxLength: 88 },
            nonce: { type: "string", minLength: 20, maxLength: 64 }
          }
        }
      }
    },
    async (req, reply) => {
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
      const started = Date.now();
      const result = await walletAuth.verify(req.body);
      if (!result.ok) {
        logger.warn("wallet auth verify rejected", {
          requestId,
          authChallengeId: req.body.challengeId,
          walletHash: hashWalletForLog(req.body.wallet),
          authResult: result.code,
          durationMs: Date.now() - started
        });
        return reply.code(result.statusCode).send({ error: { code: result.code, message: result.message }, meta: { requestId } });
      }
      logger.info("wallet auth success", {
        requestId,
        authChallengeId: req.body.challengeId,
        walletHash: hashWalletForLog(req.body.wallet),
        authResult: "SUCCESS",
        isNewUser: result.isNewUser,
        sessionId: result.session.id,
        durationMs: Date.now() - started
      });
      return reply.send({
        data: { token: result.token, user: { id: result.user.id, wallet: result.user.wallet }, expiresAt: result.session.expires_at },
        meta: { requestId }
      });
    }
  );

  app.post("/v1/auth/logout", async (req, reply) => {
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const revoked = token ? await walletAuth.logout(token) : false;
    logger.info("wallet auth logout", { requestId, revoked });
    return reply.send({ data: { revoked }, meta: { requestId } });
  });

  // ---- D6-P: session identity ----

  app.get("/v1/auth/me", async (req, reply) => {
    const user = req.user;
    if (!user || user.isAnonymous) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required" }, meta: { requestId: (req.headers["x-request-id"] as string) ?? "unknown" } });
    }
    return reply.send({ data: { id: user.id, wallet: user.wallet ?? null, email: user.email }, meta: { requestId: (req.headers["x-request-id"] as string) ?? "unknown" } });
  });

  // Account classification, see milestone D3-A §14: exposes evidence-backed
  // classification so the frontend can render program/mint/sysvar accounts
  // without starting an expensive analysis.
  app.get<{ Params: { address: string } }>("/v1/accounts/:address/classification", async (req, reply) => {
    const { address } = req.params;
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
    }
    let classification: AccountClassification;
    try {
      classification = await classifyAddress(provider, address);
    } catch {
      return reply.code(503).send({ code: "RPC_UNAVAILABLE", message: "Account classification unavailable right now", requestId: randomUUID() });
    }
    return reply.send({
      address,
      accountType: classification.accountType,
      confidence: classification.confidence,
      protocol: classification.protocol,
      verificationStatus: classification.verificationStatus,
      analysisEligible: isAnalysisEligible(classification.accountType),
      evidence: classification.evidence
    });
  });

  app.get("/health/ready", async (_req, reply) => {
    // Readiness reflects the real dependency state, see D3-J §59 and D4-I §87:
    // LIVE = process up, READY = db+redis+queue ok, DEGRADED = non-core dep
    // (RPC, monitoring, email) down. A dead email provider must never mark
    // the whole application dead.
    const checks: Record<string, boolean> = { postgres: false, redis: false, queue: false, rpc: false, monitoring: false, email: false };
    try {
      await sql`select 1`;
      checks.postgres = true;
    } catch {
      // keep false
    }
    try {
      await cache.get("health:probe");
      checks.redis = true;
    } catch {
      // keep false
    }
    try {
      const counts = await queues.analysisStandard.getJobCounts();
      checks.queue = counts !== null;
    } catch {
      // keep false
    }
    try {
      await provider.getLatestBlockHeight();
      checks.rpc = true;
    } catch {
      // keep false
    }
    if (config.ENABLE_MONITORING) {
      try {
        const counts = await queues.monitoring.getJobCounts();
        checks.monitoring = counts !== null;
      } catch {
        // keep false
      }
    } else {
      checks.monitoring = true; // disabled is a valid state
    }
    if (config.ENABLE_EMAIL_NOTIFICATIONS) {
      // Email provider availability is informational; never fatal.
      try {
        await cache.get("health:email-probe");
        checks.email = true;
      } catch {
        // keep false
      }
    } else {
      checks.email = true; // disabled is a valid state
    }

    const allUp = Object.values(checks).every(Boolean);
    const coreUp = checks.postgres && checks.redis && checks.queue;
    if (allUp) return { status: "ok", checks };
    if (coreUp) {
      // Cache and existing reports still work; new analyses may be degraded.
      return reply.code(200).send({ status: "degraded", checks });
    }
    return reply.code(503).send({ status: "unavailable", checks });
  });

  // D6-I2 §22: population-commonality health diagnostics. No raw wallet data
  // is exposed — only aggregate counts + freshness, mirroring the engine's
  // eligibility gate (enabled ≠ eligible).
  app.get("/v1/health/commonality", async (req, reply) => {
    const { commonalityStatus } = await import("@aegix/commonality");
    try {
      const status = await commonalityStatus({ sql }, {
        version: config.COMMONALITY_VERSION,
        minPopulation: config.COMMONALITY_MIN_POPULATION,
        maxSnapshotAgeHours: config.COMMONALITY_MAX_SNAPSHOT_AGE_HOURS,
        enabled: config.ENABLE_POPULATION_COMMONALITY
      });
      return reply.send({
        data: {
          enabled: status.enabled,
          eligible: status.eligible,
          source: status.source,
          populationSize: status.populationSize,
          minimumPopulation: status.minimumPopulation,
          snapshotAgeHours: status.snapshotAgeHours === null ? null : Math.round(status.snapshotAgeHours * 10) / 10,
          stale: status.stale,
          version: status.version,
          lastAggregationAt: status.lastAggregationAt,
          reason: status.reason
        },
        meta: { requestId: (req.headers["x-request-id"] as string | undefined) ?? "unknown" }
      });
    } catch {
      return reply.code(503).send({
        error: { code: "COMMONALITY_HEALTH_UNAVAILABLE", message: "Commonality health check failed" },
        meta: { requestId: (req.headers["x-request-id"] as string | undefined) ?? "unknown" }
      });
    }
  });

  // D7: public, read-only aggregate stats for the landing page. Honest
  // numbers only — count queries + commonality status + a health snapshot.
  // No auth, no secrets; unavailability degrades to null, never fabricated.
  app.get("/v1/public/stats", async (req, reply) => {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? "unknown";
    // Whitelisted table names only — never interpolate untrusted identifiers.
    const count = async (table: "analysis_jobs" | "wallets" | "correlation_results" | "monitors"): Promise<number | null> => {
      try {
        const [row] =
          table === "analysis_jobs"
            ? await sql<Array<{ n: string }>>`select count(*)::text as n from analysis_jobs`
            : table === "wallets"
              ? await sql<Array<{ n: string }>>`select count(*)::text as n from wallets`
              : table === "correlation_results"
                ? await sql<Array<{ n: string }>>`select count(*)::text as n from correlation_results`
                : await sql<Array<{ n: string }>>`select count(*)::text as n from monitors`;
        return Number(row?.n ?? 0);
      } catch {
        return null;
      }
    };
    try {
      const [analyses, readyAnalyses, wallets, correlationResults, monitors] = await Promise.all([
        count("analysis_jobs"),
        sql<Array<{ n: string }>>`select count(*)::text as n from analysis_jobs where status = 'READY'`.catch(() => null).then((r) => Number(r?.[0]?.n ?? 0)),
        count("wallets"),
        count("correlation_results"),
        count("monitors")
      ]);
      const { commonalityStatus } = await import("@aegix/commonality");
      let commonality = { eligible: false, populationSize: null as number | null };
      try {
        const cs = await commonalityStatus({ sql }, {
          version: config.COMMONALITY_VERSION,
          minPopulation: config.COMMONALITY_MIN_POPULATION,
          maxSnapshotAgeHours: config.COMMONALITY_MAX_SNAPSHOT_AGE_HOURS,
          enabled: config.ENABLE_POPULATION_COMMONALITY
        });
        commonality = { eligible: cs.eligible, populationSize: cs.populationSize };
      } catch {
        // commonality diagnostic is best-effort for the landing panel
      }
      return reply.send({
        data: {
          analyses,
          readyAnalyses,
          cachedAnalyses: analyses === null ? null : Math.max(0, (analyses ?? 0) - (readyAnalyses ?? 0)),
          walletsAnalyzed: wallets,
          compareCount: correlationResults,
          monitors,
          populationSize: commonality.populationSize,
          populationEligible: commonality.eligible,
          generatedAt: new Date().toISOString()
        },
        meta: { requestId }
      });
    } catch {
      return reply.code(503).send({
        error: { code: "PUBLIC_STATS_UNAVAILABLE", message: "Public stats unavailable" },
        meta: { requestId }
      });
    }
  });

  app.post<{ Body: { address: string } }>(
    "/v1/analyses",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute"
        }
      },
      schema: {
        body: {
          type: "object",
          required: ["address"],
          properties: { address: { type: "string", minLength: 32, maxLength: 44 } }
        }
      }
    },
    async (req, reply) => {
      const address = req.body.address;
      if (!isValidSolanaAddress(address)) {
        return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
      }

      // Account classification before any expensive work, see D3-A §8.
      // Programs, mints, sysvars and token accounts are not analyzed as
      // user wallets.
      let classification: AccountClassification;
      try {
        classification = await classifyAddress(provider, address);
      } catch {
        return reply.code(503).send({ code: "RPC_UNAVAILABLE", message: "Account classification unavailable right now", requestId: randomUUID() });
      }
      if (!isAnalysisEligible(classification.accountType)) {
        return reply.code(422).send({
          code: "ACCOUNT_NOT_ANALYZABLE",
          accountType: classification.accountType,
          protocol: classification.protocol,
          verificationStatus: classification.verificationStatus,
          message: `Address is a ${classification.accountType.toLowerCase()} and is not analyzed as a personal wallet`,
          requestId: randomUUID()
        });
      }

      const engineVersion = ANALYSIS_PIPELINE_VERSION;

      // 1. Fresh cached analysis? Return it immediately. Cache hits do not
      // consume quota, see D3-C §24.
      const cached = await cache.getJson<{ analysisId: string }>(`${CACHE_PREFIX}:${address}`);
      if (cached?.analysisId) {
        const quotaCtx = quotaContext(req);
        await recordCacheHit(sql, quotaCtx, cached.analysisId).catch(() => {});
        return reply.send({ analysisId: cached.analysisId, cached: true });
      }

      // 2. Distributed lock: deduplicate concurrent analyses for the same wallet.
      const lockKey = analysisLockKey(address, engineVersion);
      const lockAcquired = await cache.acquireLock(lockKey, 300);
      if (!lockAcquired) {
        const existing = await cache.getJson<{ analysisId: string }>(`${CACHE_PREFIX}:${address}`);
        if (existing?.analysisId) {
          return reply.send({ analysisId: existing.analysisId, cached: true });
        }
        return reply.code(409).send({
          code: "ANALYSIS_IN_PROGRESS",
          message: "An analysis for this wallet is already in progress",
          requestId: randomUUID()
        });
      }

      try {
        // 3. Check for a recent READY analysis before creating a duplicate job.
        const wallet = await walletRepo.findOrCreate("solana", address);
        const latest = await jobRepo.latestForWallet(wallet.id);
        if (latest && latest.fresh_until && new Date(latest.fresh_until) > new Date()) {
          await cache.setJson(`${CACHE_PREFIX}:${address}`, { analysisId: latest.id }, config.ANALYSIS_CACHE_TTL_SECONDS);
          return reply.send({ analysisId: latest.id, cached: true });
        }

        // 4. Admission control before creating an expensive job, see D3-C.
        const user = req.user;
        if (user && !user.isAnonymous) {
          await auth.ensureProfile(user, sql);
        }
        const admission = await checkAdmission({
          queues,
          sql,
          config,
          userId: user && !user.isAnonymous ? user.id : null,
          ip: req.ip
        });
        if (!admission.admitted) {
          return reply.code(503).send(admission.body);
        }

        // 5. Quota check, see D3-F: only expensive analyses consume quota.
        // The registered-user limit is the plan entitlement (D11); anonymous
        // visitors keep the config limit, since a plan needs an identity.
        const analysisActor = user && !user.isAnonymous ? user.id : null;
        const quota = await checkQuota(sql, config, quotaContext(req), {
          limitOverride: analysisActor ? await entitlements.limit(analysisActor, "analysis.daily") : undefined
        });
        if (!quota.allowed) {
          return reply.code(429).send({
            code: "ANALYSIS_QUOTA_EXCEEDED",
            resetAt: quota.resetAt,
            message: `Daily analysis limit reached (${quota.limit}), resets at ${quota.resetAt}`,
            requestId: randomUUID()
          });
        }

        const job = await jobRepo.create({
          walletId: wallet.id,
          requestedBy: user && !user.isAnonymous ? user.id : null,
          analysisType: "full",
          priority: "standard"
        });

        // Record origin IP for pending-per-IP limits.
        await sql`update analysis_jobs set ip_address = ${req.ip} where id = ${job.id}`;
        await recordQuotaUsage(sql, quotaContext(req), job.id).catch(() => {});

        const queue = queueForPriority(job.priority, queues);
        await queue.add(
          "analyze",
          { analysisId: job.id, walletAddress: address, chain: "solana", analysisType: "full" },
          { jobId: `analysis-${job.id}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } }
        );

        await cache.setJson(`${CACHE_PREFIX}:${address}`, { analysisId: job.id }, config.ANALYSIS_CACHE_TTL_SECONDS);

        reply.code(202).send({
          analysisId: job.id,
          status: job.status,
          walletAddress: address,
          requestId: req.headers["x-request-id"]
        });
      } finally {
        await cache.releaseLock(lockKey);
      }
    }
  );

  app.get<{ Params: { id: string } }>("/v1/analyses/:id", async (req, reply) => {
    const job = await jobRepo.findById(req.params.id);
    if (!job) {
      return reply.code(404).send({ code: "INTERNAL_ERROR", message: "Analysis not found", requestId: randomUUID() });
    }
    const wallet = await walletRepo.findById(job.wallet_id);
    return reply.send({
      analysisId: job.id,
      wallet: wallet?.address ?? null,
      status: job.status,
      progress: job.progress,
      engineVersion: job.engine_version,
      createdAt: job.requested_at,
      completedAt: job.completed_at,
      failureCode: job.failure_code
    });
  });

  app.get<{ Params: { id: string } }>("/v1/analyses/:id/status", async (req, reply) => {
    const job = await jobRepo.findById(req.params.id);
    if (!job) {
      return reply.code(404).send({ code: "INTERNAL_ERROR", message: "Analysis not found", requestId: randomUUID() });
    }
    return reply.send({ analysisId: job.id, status: job.status, progress: job.progress });
  });

  app.get<{ Params: { address: string } }>("/v1/wallets/:address/latest", async (req, reply) => {
    const { address } = req.params;
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
    }
    const wallet = await walletRepo.findByAddress("solana", address);
    if (!wallet) {
      return reply.code(404).send({ code: "CHAIN_DATA_UNAVAILABLE", message: "Wallet not found", requestId: randomUUID() });
    }
    // Newest job of any status: the report page polls this after /x-ray 404s
    // to find an analysis that is still running. A READY-only lookup left a
    // first-time analysis stuck on "No analysis yet".
    const latest = await jobRepo.latestJobForWallet(wallet.id);
    return reply.send({ wallet: address, latestAnalysisId: latest?.id ?? null, status: latest?.status ?? null });
  });

  app.get<{ Params: { address: string } }>("/v1/wallets/:address/x-ray", async (req, reply) => {
    const { address } = req.params;
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
    }

    const wallet = await walletRepo.findByAddress("solana", address);
    if (!wallet) {
      return reply.code(404).send({ code: "CHAIN_DATA_UNAVAILABLE", message: "Wallet not found", requestId: randomUUID() });
    }

    const latest = await jobRepo.latestForWallet(wallet.id);
    if (!latest) {
      return reply.code(404).send({ code: "CHAIN_DATA_UNAVAILABLE", message: "No analysis available for this wallet", requestId: randomUUID() });
    }

    const [score, signals, paths] = await Promise.all([
      intelligenceRepo.scoreForAnalysis(latest.id),
      intelligenceRepo.signalsForAnalysis(latest.id),
      intelligenceRepo.pathsForAnalysis(latest.id)
    ]);

    // D5-I §45-§47: potential wallet correlations from persisted results
    // (bounded, no forced discovery). Only qualifying correlations are shown.
    let correlations: Array<{ wallet: string; score: number; confidence: number; families: string[]; classification: string }> = [];
    if (config.ENABLE_CORRELATION_ANALYSIS) {
      try {
        const correlationRepo = createCorrelationRepo(sql);
        const rows = await correlationRepo.listForWallet(address, config.MAX_CORRELATION_CANDIDATE_WALLETS);
        correlations = rows
          .filter((r) => r.correlation_score >= config.MIN_INFERRED_EDGE_SCORE && Number(r.confidence) >= config.MIN_INFERRED_EDGE_CONFIDENCE)
          .sort((a, b) => b.correlation_score - a.correlation_score)
          .slice(0, 10)
          .map((r) => {
            const other = r.wallet_a === address ? r.wallet_b : r.wallet_a;
            return {
              wallet: other,
              score: r.correlation_score,
              confidence: Number(r.confidence),
              families: ((r.evidence_families ?? []) as Array<{ family: string }>).map((f) => f.family),
              classification: r.classification
            };
          });
      } catch {
        correlations = [];
      }
    }

    return reply.send({ ...buildXRayResponse({ address, job: latest, score, signals, paths }), correlations });
  });

  /**
   * Assembles the D8 profile from what the pipeline already persisted.
   *
   * No re-analysis happens here, which is why neither caller consumes
   * analysis quota. Ask AEGIX reads the same profile, so the model can only
   * ever see evidence the deterministic layer already published.
   */
  const loadWalletContextProfile = async (address: string): Promise<WalletContextProfile | null> => {
    const wallet = await walletRepo.findByAddress("solana", address);
    if (!wallet) return null;

    const latest = await jobRepo.latestForWallet(wallet.id);
    if (!latest) return null;

    const [score, signals] = await Promise.all([
      intelligenceRepo.scoreForAnalysis(latest.id),
      intelligenceRepo.signalsForAnalysis(latest.id)
    ]);

    const dataQuality = (latest.data_quality ?? {}) as Record<string, unknown>;
    return buildWalletContext({
      walletAddress: address,
      analysisId: latest.id,
      pipelineVersion: latest.engine_version,
      scoringVersion: score?.scoring_version ?? null,
      signals: signals.map(toIntelligenceSignal),
      supportingEvidence: await loadContextSupporting(sql, wallet.id, address, latest.id),
      dimensions: scoreDimensions(score),
      coverage: {
        transactionsParsed: typeof dataQuality.transactionsParsed === "number" ? dataQuality.transactionsParsed : 0,
        historyStart: typeof dataQuality.historyStart === "string" ? dataQuality.historyStart : null,
        historyEnd: typeof dataQuality.historyEnd === "string" ? dataQuality.historyEnd : null,
        dataQualityScore: typeof dataQuality.dataQualityScore === "number" ? dataQuality.dataQualityScore : null,
        grade: typeof dataQuality.grade === "string" ? dataQuality.grade : null
      }
    });
  };

  // ---- Wallet Context profile (D8) ----

  app.get<{ Params: { address: string } }>(
    "/v1/wallets/:address/context",
    {
      config: {
        rateLimit: {
          max: config.WALLET_CONTEXT_RATE_LIMIT_PER_MINUTE,
          timeWindow: "1 minute"
        }
      }
    },
    async (req, reply) => {
      if (!config.ENABLE_WALLET_CONTEXT) {
        return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Wallet context is disabled", requestId: randomUUID() });
      }

      const { address } = req.params;
      if (!isValidSolanaAddress(address)) {
        return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
      }

      // The target wallet is whatever the caller asks about. It is deliberately
      // unrelated to the wallet they signed in with: context is a read over
      // public chain analysis, not a statement about the session.
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      const planGate = await featureGate(reply, user.id, "WALLET_CONTEXT");
      if (planGate) return planGate;

      const profile = await loadWalletContextProfile(address);
      if (!profile) {
        return reply.code(404).send({ code: "CHAIN_DATA_UNAVAILABLE", message: "No analysis available for this wallet", requestId: randomUUID() });
      }

      try {
        await recordQuotaUsage(sql, quotaContext(req), profile.analysisId, "wallet_context");
      } catch {
        // Metering must never fail the read it is measuring.
      }

      return reply.send(profile);
    }
  );

  // ---- Wallet comparison (D5-I §19-§26, §45-§48) ----

  app.post<{ Body: { walletA: string; walletB: string } }>(
    "/v1/compare",
    {
      config: {
        rateLimit: {
          max: config.COMPARE_RATE_LIMIT_PER_MINUTE,
          timeWindow: "1 minute"
        }
      },
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
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
      const { walletA, walletB } = req.body;

      // Input validation (D5-L §95): format, duplicate, unsupported type.
      if (!isValidSolanaAddress(walletA) || !isValidSolanaAddress(walletB)) {
        return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId });
      }
      if (walletA === walletB) {
        return reply.code(400).send({ code: "DUPLICATE_WALLET", message: "Cannot compare a wallet with itself", requestId });
      }

      // Kill switches (D5-L §94): comparison depends on D5 intelligence.
      if (!config.ENABLE_CORRELATION_ANALYSIS || !config.ENABLE_MULTI_HOP_GRAPH) {
        return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Wallet comparison is currently disabled", requestId });
      }

      // Account classification before any work (D5-I §21): programs, mints,
      // sysvars and token accounts are not user wallets.
      for (const address of [walletA, walletB]) {
        let classification: AccountClassification;
        try {
          classification = await classifyAddress(provider, address);
        } catch {
          return reply.code(503).send({ code: "RPC_UNAVAILABLE", message: "Account classification unavailable right now", requestId });
        }
        if (!isAnalysisEligible(classification.accountType)) {
          return reply.code(422).send({
            code: "ACCOUNT_NOT_COMPARABLE",
            accountType: classification.accountType,
            protocol: classification.protocol,
            address,
            message: `Address ${address.slice(0, 6)}… is a ${classification.accountType.toLowerCase()} and is not compared as a personal wallet`,
            requestId
          });
        }
      }

      const pairId = canonicalComparePair(walletA, walletB);

      // 1. Canonical cache: (A,B) == (B,A) — symmetric reuse (D5-I §25).
      const cacheHit = await cachedComparison({ sql, config }, pairId);
      if (cacheHit) {
        logger.info("comparison cache hit", { requestId, pairId, score: cacheHit.correlation.correlationScore });
        return reply.send({ ...cacheHit, cached: true });
      }

      // 2. Distributed dedup lock: concurrent identical comparisons share one
      // expensive run (§26).
      const lockAcquired = await cache.acquireLock(compareLockKey(pairId), 120);
      if (!lockAcquired) {
        const existing = await cachedComparison({ sql, config }, pairId);
        if (existing) return reply.send({ ...existing, cached: true });
        return reply.code(409).send({ code: "COMPARISON_IN_PROGRESS", message: "This comparison is already being computed", requestId });
      }

      try {
        // 3. Admission + quota: comparison is more expensive than retrieval
        // (D5-L §90-§93).
        const user = req.user;
        if (user && !user.isAnonymous) await auth.ensureProfile(user, sql);
        const admission = await checkAdmission({ queues, sql, config, userId: user && !user.isAnonymous ? user.id : null, ip: req.ip });
        if (!admission.admitted) return reply.code(503).send(admission.body);
        const quota = await checkQuota(sql, config, quotaContext(req), {
          usageType: "comparison",
          limitOverride: user && !user.isAnonymous
            ? await entitlements.limit(user.id, "compare.daily")
            : config.COMPARE_DAILY_ANON_LIMIT
        });
        if (!quota.allowed) {
          return reply.code(429).send({ code: "COMPARISON_QUOTA_EXCEEDED", resetAt: quota.resetAt, message: `Daily comparison limit reached (${quota.limit}), resets at ${quota.resetAt}`, requestId });
        }

        // 4. Reuse-first: both wallets must already have fresh READY analyses.
        const freshA = await loadFreshAnalysis({ sql, config }, walletA);
        const freshB = await loadFreshAnalysis({ sql, config }, walletB);
        if (!freshA || !freshB) {
          const missing = !freshA ? walletA : walletB;
          return reply.code(422).send({
            code: "ANALYSIS_REQUIRED",
            message: `No fresh analysis available for ${missing.slice(0, 6)}… — analyze it first`,
            requestId
          });
        }

        const result = await runComparison({ sql, config }, { walletA, walletB });
        await recordQuotaUsage(sql, quotaContext(req), null, "comparison").catch(() => {});
        await cache.setJson(compareCacheKey(pairId), result, config.CORRELATION_CACHE_TTL_SECONDS);

        logger.info("comparison complete", {
          requestId,
          pairId,
          correlationScore: result.correlation.correlationScore,
          confidence: result.correlation.confidence,
          analysisA: freshA.job.id,
          analysisB: freshB.job.id,
          paths: result.relationshipPaths.length,
          clusters: result.clusters.length
        });

        return reply.send({ ...result, cached: false });
      } finally {
        await cache.releaseLock(compareLockKey(pairId));
      }
    }
  );

  app.get<{ Params: { pairId: string } }>("/v1/compare/:pairId", async (req, reply) => {
    const { pairId } = req.params;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}\|[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pairId)) {
      return reply.code(400).send({ code: "INVALID_PAIR", message: "Invalid comparison pair id", requestId: randomUUID() });
    }
    const hit = await cachedComparison({ sql, config }, pairId);
    if (!hit) {
      return reply.code(404).send({ code: "COMPARISON_NOT_FOUND", message: "Comparison not found — run a compare first", requestId: randomUUID() });
    }
    return reply.send({ ...hit, cached: true });
  });

  // ---- Saved analyses (authenticated), see D3-E §31-§33 and D3-G §38 ----

  app.get("/v1/me/saved", async (req, reply) => {
    if (!config.ENABLE_SAVE_WALLET) {
      return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Saving wallets is disabled", requestId: randomUUID() });
    }
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const planGate = await featureGate(reply, user.id, "SAVED_ANALYSES");
    if (planGate) return planGate;
    await auth.ensureProfile(user, sql);
    const saved = await savedRepo.listForUser(user.id);
    return reply.send({ saved });
  });

  app.post<{ Body: { address: string; label?: string | null } }>(
    "/v1/me/saved",
    {
      schema: {
        body: {
          type: "object",
          required: ["address"],
          properties: { address: { type: "string", minLength: 32, maxLength: 44 }, label: { type: "string", maxLength: 100 } }
        }
      }
    },
    async (req, reply) => {
      if (!config.ENABLE_SAVE_WALLET) {
        return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Saving wallets is disabled", requestId: randomUUID() });
      }
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      const planGate = await featureGate(reply, user.id, "SAVED_ANALYSES");
      if (planGate) return planGate;
      await auth.ensureProfile(user, sql);

      const { address, label } = req.body;
      if (!isValidSolanaAddress(address)) {
        return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
      }
      const wallet = await walletRepo.findOrCreate("solana", address);
      const latest = await jobRepo.latestForWallet(wallet.id);
      const saved = await savedRepo.save({
        userId: user.id,
        walletId: wallet.id,
        analysisId: latest?.id ?? null,
        label: label ?? null
      });
      return reply.code(201).send({ saved });
    }
  );

  app.delete<{ Params: { address: string } }>("/v1/me/saved/:address", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const { address } = req.params;
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
    }
    const wallet = await walletRepo.findByAddress("solana", address);
    if (!wallet) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Wallet not found", requestId: randomUUID() });
    }
    const deleted = await savedRepo.deleteForUser(user.id, wallet.id);
    return reply.send({ deleted });
  });

  // ---- Saved comparisons (D6-A): user-owned bookmarks referencing the
  // shared comparison result. The intelligence payload is NOT copied per
  // user; opening a saved comparison reuses the persisted result first and
  // never triggers analysis automatically (docs/d6-block1.md D6-A).

  const savedComparisonGate = (reply: FastifyReply) => {
    if (!config.ENABLE_SAVED_COMPARISONS) {
      return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Saved comparisons are disabled", requestId: randomUUID() });
    }
    return null;
  };

  app.post<{ Body: { walletA: string; walletB: string; label?: string | null; notes?: string | null } }>(
    "/v1/me/saved-comparisons",
    {
      schema: {
        body: {
          type: "object",
          required: ["walletA", "walletB"],
          properties: {
            walletA: { type: "string", minLength: 32, maxLength: 44 },
            walletB: { type: "string", minLength: 32, maxLength: 44 },
            label: { type: "string", maxLength: 120 },
            notes: { type: "string", maxLength: 2000 }
          }
        }
      }
    },
    async (req, reply) => {
      const gate = savedComparisonGate(reply);
      if (gate) return gate;
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      const planGate = await featureGate(reply, user.id, "SAVED_COMPARISONS");
      if (planGate) return planGate;
      await auth.ensureProfile(user, sql);
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

      const { walletA, walletB, label, notes } = req.body;
      if (!isValidSolanaAddress(walletA) || !isValidSolanaAddress(walletB)) {
        return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId });
      }
      if (walletA === walletB) {
        return reply.code(400).send({ code: "DUPLICATE_WALLET", message: "Cannot save a comparison of a wallet with itself", requestId });
      }

      // Reference the existing persisted correlation result if present.
      // Do NOT rerun analysis because the user clicks Save (D6-A §12).
      const pairId = canonicalComparePair(walletA, walletB);
      const result = await correlationRepo.findByPair(walletA, walletB);

      const saved = await savedComparisonRepo.save({
        userId: user.id,
        pairKey: pairId,
        walletA,
        walletB,
        comparisonResultId: result ? result.id : null,
        label: label ?? null,
        notes: notes ?? null
      });
      return reply.code(201).send({ saved });
    }
  );

  app.get<{ Querystring: { limit?: string; offset?: string; sort?: string; order?: string } }>("/v1/me/saved-comparisons", async (req, reply) => {
    const gate = savedComparisonGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const planGate = await featureGate(reply, user.id, "SAVED_COMPARISONS");
    if (planGate) return planGate;
    await auth.ensureProfile(user, sql);

    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const sort = req.query.sort === "updated_at" || req.query.sort === "last_opened_at" ? req.query.sort : "created_at";
    const order = req.query.order === "asc" ? "asc" : "desc";

    const saved = await savedComparisonRepo.listForUser(user.id, { limit, offset, sort, order });
    return reply.send({ saved, meta: { limit, offset, total: saved.length } });
  });

  app.get<{ Params: { id: string } }>("/v1/me/saved-comparisons/:id", async (req, reply) => {
    const gate = savedComparisonGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

    const saved = await savedComparisonRepo.getForUser(user.id, req.params.id);
    if (!saved) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Saved comparison not found", requestId });
    }

    // Historical result reuse: return the persisted correlation snapshot
    // when present, and NEVER trigger a new analysis automatically (D6-A
    // §10, §24). `stale` flags when the underlying analysis data is no
    // longer fresh; refreshing is an explicit user action (frontend).
    let comparison: CompareResult | null = null;
    let stale = false;
    if (saved.comparison_result_id) {
      const cached = await cachedComparison({ sql, config }, saved.pair_key);
      if (cached) {
        comparison = cached;
      } else {
        // Persisted result row exists but is not in the Redis cache; rebuild
        // from persisted data without triggering new analysis.
        try {
          const freshA = await loadFreshAnalysis({ sql, config }, saved.wallet_a);
          const freshB = await loadFreshAnalysis({ sql, config }, saved.wallet_b);
          if (freshA && freshB) {
            comparison = await runComparison({ sql, config }, { walletA: saved.wallet_a, walletB: saved.wallet_b });
          } else {
            stale = true;
          }
        } catch {
          stale = true;
        }
      }
    } else {
      stale = true;
    }
    await savedComparisonRepo.touchOpenedForUser(user.id, saved.id);
    return reply.send({ saved, comparison, stale });
  });

  app.patch<{ Params: { id: string }; Body: { label?: string | null; notes?: string | null } }>(
    "/v1/me/saved-comparisons/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            label: { type: ["string", "null"], maxLength: 120 },
            notes: { type: ["string", "null"], maxLength: 2000 }
          }
        }
      }
    },
    async (req, reply) => {
      const gate = savedComparisonGate(reply);
      if (gate) return gate;
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

      const { label, notes } = req.body;
      if (label === undefined && notes === undefined) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "Provide label and/or notes", requestId });
      }
      const updated = await savedComparisonRepo.updateForUser(user.id, req.params.id, { label: label ?? null, notes: notes ?? null });
      if (!updated) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Saved comparison not found", requestId });
      }
      return reply.send({ saved: updated });
    }
  );

  app.delete<{ Params: { id: string } }>("/v1/me/saved-comparisons/:id", async (req, reply) => {
    const gate = savedComparisonGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

    const deleted = await savedComparisonRepo.deleteForUser(user.id, req.params.id);
    if (!deleted) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Saved comparison not found", requestId });
    }
    // Deleting the saved reference does NOT delete the shared correlation
    // result (D6-A §16): correlation_results is public blockchain-derived
    // data reused by other users and the X-Ray section.
    return reply.send({ deleted: true });
  });

  // ---- Developer API (D6-B..D6-D): versioned /v1/developer namespace,
  // Bearer API-key auth, scopes, per-user quota + usage metering.
  // Block 1 exposes only key management + status + usage — the D1-D5
  // intelligence endpoints are NOT exposed yet (D6-E will do that).

  const developerGate = (reply: FastifyReply) => {
    if (!config.ENABLE_DEVELOPER_API) {
      return developerError(reply, "FEATURE_DISABLED", "The developer API is currently disabled", 403, randomUUID());
    }
    return null;
  };

  /** Records a metered developer request (attribution, D6-D §73). */
  async function recordDeveloperUsage(input: {
    developer: { userId: string; apiKeyId: string } | null;
    requestId: string;
    operation: string;
    status: "SUCCESS" | "REJECTED";
    units?: number;
    cacheHit?: boolean;
    createdWork?: boolean;
    latencyMs?: number;
    scope?: string;
  }): Promise<void> {
    await developerUsageRepo.record({
      userId: input.developer?.userId ?? null,
      apiKeyId: input.developer?.apiKeyId ?? null,
      requestId: input.requestId,
      operation: input.operation,
      status: input.status,
      units: input.units,
      cacheHit: input.cacheHit,
      createdWork: input.createdWork,
      latencyMs: input.latencyMs,
      scope: input.scope
    }).catch(() => {});
  }

  app.get(
    "/v1/developer/status",
    {
      config: {
        rateLimit: {
          max: config.DEVELOPER_RATE_LIMIT_PER_MINUTE,
          timeWindow: "1 minute"
        }
      }
    },
    async (req, reply) => {
      const gate = developerGate(reply);
      if (gate) return gate;
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
      const started = Date.now();
      const result = await developerAuth.authenticate(req);
      if (!result.ok) {
        await recordDeveloperUsage({
          developer: null,
          requestId,
          operation: "developer.status",
          status: "REJECTED",
          latencyMs: Date.now() - started
        }).catch(() => {});
        return developerError(reply, result.code, result.message, result.statusCode, requestId);
      }
      const { developer } = result;

      // Meter the request: atomic per-user quota claim (D6-D §69-§70).
      const quota = await developerAuth.checkAndClaimQuota(developer, { units: 1 });
      if (!quota.allowed) {
        await recordDeveloperUsage({
          developer,
          requestId,
          operation: "developer.status",
          status: "REJECTED",
          latencyMs: Date.now() - started
        });
        return developerError(reply, "QUOTA_EXCEEDED", `Daily developer quota exceeded (limit ${quota.summary.limit}, resets ${quota.summary.resetAt})`, 429, requestId);
      }

      setQuotaHeaders(reply, quota.summary, { limit: config.DEVELOPER_RATE_LIMIT_PER_MINUTE, remaining: config.DEVELOPER_RATE_LIMIT_PER_MINUTE, resetAt: Math.floor(Date.now() / 1000) + 60 });
      await recordDeveloperUsage({
        developer,
        requestId,
        operation: "developer.status",
        status: "SUCCESS",
        latencyMs: Date.now() - started,
        scope: "status"
      });

      logger.info("developer request", {
        requestId,
        developerUserId: developer.userId,
        apiKeyId: developer.apiKeyId,
        apiKeyPrefix: developer.apiKeyPrefix,
        operation: "developer.status",
        scope: "status",
        quotaUsed: quota.summary.used,
        quotaRemaining: quota.summary.remaining,
        statusCode: 200,
        durationMs: Date.now() - started
      });

      return developerSuccess(reply, { status: "ok", scopes: developer.scopes, keyPrefix: developer.apiKeyPrefix }, requestId, {
        quota: { limit: quota.summary.limit, used: quota.summary.used, remaining: quota.summary.remaining, resetAt: quota.summary.resetAt }
      });
    }
  );

  // ---- D6-C: API key management (product-session auth, not API-key auth) ----

  app.post<{ Body: { name: string; scopes?: string[]; expiresInDays?: number | null } }>(
    "/v1/developer/keys",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            scopes: { type: "array", items: { type: "string" }, maxItems: 4 },
            expiresInDays: { type: ["number", "null"], minimum: 1, maximum: 365 }
          }
        }
      }
    },
    async (req, reply) => {
      const gate = developerGate(reply);
      if (gate) return gate;
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      await auth.ensureProfile(user, sql);
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

      const name = req.body.name.trim();
      if (!name) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "Key name is required", requestId });
      }
      const requestedScopes = req.body.scopes ?? ["intelligence:read"];
      const unknown = requestedScopes.filter((s) => !KNOWN_API_KEY_SCOPES.includes(s as ApiKeyScope));
      if (unknown.length > 0) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: `Unknown scope(s): ${unknown.join(", ")}. Valid scopes: ${KNOWN_API_KEY_SCOPES.join(", ")}`, requestId });
      }
      const scopes = [...new Set(requestedScopes)] as ApiKeyScope[];

      const keyLimit = await entitlements.limit(user.id, "apiKeys.active");
      const activeCount = await developerKeyRepo.countActiveForUser(user.id);
      if (activeCount >= keyLimit) {
        return reply.code(429).send({ code: "KEY_LIMIT_REACHED", message: `Active API key limit reached (${keyLimit})`, requestId });
      }

      const { key, keyPrefix, keyHash } = generateApiKey();
      const ttlDays = req.body.expiresInDays ?? (config.API_KEY_DEFAULT_TTL_DAYS > 0 ? config.API_KEY_DEFAULT_TTL_DAYS : null);
      const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null;

      const row = await developerKeyRepo.create({ userId: user.id, name, keyPrefix, keyHash, scopes, expiresAt });

      // The plaintext key is returned exactly once (D6-C §43, §87). The
      // database row only ever contains the hash; there is no retrieval path.
      return reply.code(201).send({
        key: {
          id: row.id,
          name: row.name,
          key,
          keyPrefix: row.key_prefix,
          scopes,
          createdAt: row.created_at,
          expiresAt
        }
      });
    }
  );

  app.get("/v1/developer/keys", async (req, reply) => {
    const gate = developerGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    await auth.ensureProfile(user, sql);

    const rows = await developerKeyRepo.listForUser(user.id);
    const keys: DeveloperApiKeyView[] = rows.map((r) => developerKeyToView(r));
    return reply.send({ keys });
  });

  app.post<{ Params: { id: string } }>("/v1/developer/keys/:id/revoke", async (req, reply) => {
    const gate = developerGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

    const revoked = await developerKeyRepo.revokeForUser(user.id, req.params.id);
    if (!revoked) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Active API key not found", requestId });
    }
    logger.info("developer api key revoked", { requestId, developerUserId: user.id, apiKeyId: revoked.id, apiKeyPrefix: `${revoked.key_prefix}…` });
    return reply.send({ revoked: developerKeyToView(revoked) });
  });

  app.post<{ Params: { id: string } }>("/v1/developer/keys/:id/rotate", async (req, reply) => {
    const gate = developerGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();

    const existing = await developerKeyRepo.getForUser(user.id, req.params.id);
    if (!existing || existing.status !== "ACTIVE") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Active API key not found", requestId });
    }
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Cannot rotate an expired key — create a new key instead", requestId });
    }
    const rotateKeyLimit = await entitlements.limit(user.id, "apiKeys.active");
    const activeCount = await developerKeyRepo.countActiveForUser(user.id);
    if (activeCount >= rotateKeyLimit) {
      return reply.code(429).send({ code: "KEY_LIMIT_REACHED", message: `Active API key limit reached (${rotateKeyLimit})`, requestId });
    }

    // Generate the new key first, then revoke the old one in the same
    // transaction: persistence failure never leaves the user with no key
    // (D6-C §48).
    const { key, keyPrefix, keyHash } = generateApiKey();
    const created = await sql.begin(async (tx) => {
      const keyRepoTx = createDeveloperApiKeyRepo(tx);
      const newKey = await keyRepoTx.create({
        userId: user.id,
        name: existing.name,
        keyPrefix,
        keyHash,
        scopes: (existing.scopes as ApiKeyScope[]) ?? [],
        expiresAt: existing.expires_at
      });
      await keyRepoTx.revokeForUser(user.id, existing.id);
      return newKey;
    });

    logger.info("developer api key rotated", { requestId, developerUserId: user.id, apiKeyId: existing.id, apiKeyPrefix: `${existing.key_prefix}…` });
    return reply.code(201).send({
      key: {
        id: created.id,
        name: created.name,
        key,
        keyPrefix: created.key_prefix,
        scopes: (created.scopes as ApiKeyScope[]) ?? [],
        createdAt: created.created_at,
        expiresAt: created.expires_at
      }
    });
  });

  // ---- D6-D: usage summary (requires usage:read scope) ----

  app.get(
    "/v1/developer/usage",
    {
      config: {
        rateLimit: {
          max: config.DEVELOPER_RATE_LIMIT_PER_MINUTE,
          timeWindow: "1 minute"
        }
      }
    },
    async (req, reply) => {
      const gate = developerGate(reply);
      if (gate) return gate;
      const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
      const started = Date.now();

      const developer = await developerAuth.requireScope(req, reply, "usage:read");
      if (!developer) return;

      const summary = await developerUsageRepo.summaryForUser(developer.userId, await developerAuth.quotaLimitFor(developer.userId));
      setQuotaHeaders(reply, { limit: summary.limit, remaining: summary.remaining, resetAt: summary.resetAt }, { limit: config.DEVELOPER_RATE_LIMIT_PER_MINUTE, remaining: config.DEVELOPER_RATE_LIMIT_PER_MINUTE, resetAt: Math.floor(Date.now() / 1000) + 60 });
      await recordDeveloperUsage({
        developer,
        requestId,
        operation: "developer.usage.read",
        status: "SUCCESS",
        latencyMs: Date.now() - started,
        scope: "usage:read"
      });

      return developerSuccess(reply, summary, requestId);
    }
  );

  // The developer portal reads the same summary with the wallet session.
  // `/v1/developer/usage` stays API-key only (usage:read scope) for
  // integrations; a session token there is rejected as a malformed key, which
  // left the portal's usage page reporting 0/0.
  app.get("/v1/me/developer/usage", async (req, reply) => {
    const gate = developerGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    await auth.ensureProfile(user, sql);
    const summary = await developerUsageRepo.summaryForUser(user.id, await developerAuth.quotaLimitFor(user.id));
    return reply.send(summary);
  });

  // ---- D6-E: developer intelligence API (thin orchestration, D6-E §43) ----
  registerDeveloperIntelligence({
    app,
    sql,
    config,
    logger,
    queues,
    developerAuth,
    recordUsage: recordDeveloperUsage
  });

  // ---- D6-H: webhook management (product session, §124) ----
  // ---- Ask AEGIX (D9) ----
  // Constructed here and passed in, so the boundary is a provider interface
  // rather than a vendor SDK reaching into route code.
  registerAskAegix({
    app,
    sql,
    config,
    logger,
    provider: createOpenAICompatibleProvider({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY }),
    loadContext: loadWalletContextProfile,
    requireUser: requireUser as never,
    checkDailyQuota: async (userId, analysisId) =>
      claimDailyUsage(sql, userId, "ask_aegix", await entitlements.limit(userId, "ask.daily"), analysisId),
    recordUsage: async () => { /* admission already persisted before provider work */ }
  });

  registerMarkets({ app, config, logger,
    service: createMarketService({ provider: deps.marketProvider ?? createCoinPaprikaProvider({ baseUrl: config.MARKETS_BASE_URL, timeoutMs: config.MARKETS_TIMEOUT_MS }), cache, cacheSeconds: config.MARKETS_CACHE_SECONDS }),
    provider: createOpenAICompatibleProvider({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY }),
    requireUser,
    loadWalletContext: loadWalletContextProfile,
    claimQuota: async (userId, ai) =>
      claimDailyUsage(
        sql,
        userId,
        ai ? "ask_aegix" : "markets",
        await entitlements.limit(userId, ai ? "ask.daily" : "markets.daily")
      )
  });

  // ---- D11: billing / entitlements (architecture.md §69) ----
  registerBilling({
    app,
    config,
    logger,
    repo: billingRepo,
    entitlements,
    provider: paymentProvider,
    requireUser,
    countActiveMonitors: (userId) => monitorRepo.countActiveForUser(userId)
  });

  registerWebhookRoutes({
    app,
    sql,
    config,
    logger,
    requireUser,
    activeWebhookLimit: (userId) => entitlements.limit(userId, "webhooks.active")
  });

  // ---- Privacy monitors, see milestone D4 (D4-A, D4-E, D4-F, D4-G) ----
  // All routes require a verified registered user (server-side auth, D3-D).
  // Monitor work is scheduled by the worker; the API only manages state.

  const monitorGate = (reply: FastifyReply) => {
    if (!config.ENABLE_MONITORING) {
      return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Privacy monitoring is disabled", requestId: randomUUID() });
    }
    return null;
  };

  /** Allowed schedule types from config; EVERY_MINUTE only in test environments. */
  function allowedSchedules(): string[] {
    const base = config.MONITOR_ALLOWED_SCHEDULES.split(",").map((s) => s.trim()).filter(Boolean);
    if (config.MONITOR_TEST_SCHEDULES_ENABLED) base.push("EVERY_MINUTE");
    return base;
  }

  function scheduleIntervalMs(scheduleType: string): number {
    switch (scheduleType) {
      case "EVERY_6_HOURS": return 6 * 3600_000;
      case "EVERY_12_HOURS": return 12 * 3600_000;
      case "EVERY_MINUTE": return 60_000;
      default: return 24 * 3600_000; // DAILY
    }
  }

  app.get("/v1/me/monitors", async (req, reply) => {
    const gate = monitorGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    await auth.ensureProfile(user, sql);
    const monitors = await monitorRepo.listForUser(user.id);
    return reply.send({ monitors });
  });

  app.post<{ Body: { address: string; scheduleType?: string } }>(
    "/v1/me/monitors",
    {
      schema: {
        body: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string", minLength: 32, maxLength: 44 },
            scheduleType: { type: "string" }
          }
        }
      }
    },
    async (req, reply) => {
      const gate = monitorGate(reply);
      if (gate) return gate;
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      await auth.ensureProfile(user, sql);

      const { address } = req.body;
      if (!isValidSolanaAddress(address)) {
        return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address", requestId: randomUUID() });
      }

      const scheduleType = req.body.scheduleType ?? config.MONITOR_DEFAULT_SCHEDULE;
      if (!allowedSchedules().includes(scheduleType)) {
        return reply.code(400).send({ code: "INVALID_SCHEDULE", message: `Schedule must be one of: ${allowedSchedules().join(", ")}`, requestId: randomUUID() });
      }

      const wallet = await walletRepo.findByAddress("solana", address);
      if (!wallet) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Wallet not found — analyze it first", requestId: randomUUID() });
      }
      const saved = await savedRepo.getForUser(user.id, wallet.id);
      if (!saved) {
        return reply.code(400).send({ code: "WALLET_NOT_SAVED", message: "Save the wallet before enabling monitoring", requestId: randomUUID() });
      }

      const monitorLimit = await entitlements.limit(user.id, "monitors.active");
      const active = await monitorRepo.countActiveForUser(user.id);
      if (active >= monitorLimit) {
        return reply.code(429).send({
          code: "MONITOR_LIMIT_REACHED",
          message: `Monitor limit reached (${monitorLimit} active)`,
          requestId: randomUUID()
        });
      }

      const latest = await jobRepo.latestForWallet(wallet.id);
      const nextCheckAt = new Date(Date.now() + scheduleIntervalMs(scheduleType)).toISOString();
      const monitor = await monitorRepo.create({
        userId: user.id,
        walletId: wallet.id,
        savedAnalysisId: saved.id,
        scheduleType,
        baselineAnalysisId: latest?.id ?? null,
        nextCheckAt
      });
      await alertRulesRepo.createWithMonitor(monitor.id, {
        minimumSeverity: "HIGH",
        minimumConfidence: config.MONITOR_MIN_CONFIDENCE,
        overallScoreDeltaThreshold: config.MONITOR_SCORE_DELTA_THRESHOLD,
        cooldownHours: config.MONITOR_EVENT_COOLDOWN_HOURS
      });
      const rules = await alertRulesRepo.getForMonitor(monitor.id);

      logger.info("monitor created", { requestId: req.headers["x-request-id"], monitorId: monitor.id, ...walletRef(address) });
      return reply.code(201).send({ monitor, rules });
    }
  );

  app.patch<{ Params: { id: string }; Body: { scheduleType?: string; status?: string; alertRules?: Record<string, unknown> } }>(
    "/v1/me/monitors/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            scheduleType: { type: "string" },
            status: { type: "string" },
            alertRules: { type: "object" }
          }
        }
      }
    },
    async (req, reply) => {
      const gate = monitorGate(reply);
      if (gate) return gate;
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;

      const monitor = await monitorRepo.getRowForUser(user.id, req.params.id);
      if (!monitor) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Monitor not found", requestId: randomUUID() });
      }

      const { scheduleType, status, alertRules } = req.body;
      if (status !== undefined) {
        if (status !== "ACTIVE" && status !== "PAUSED") {
          return reply.code(400).send({ code: "INVALID_STATUS", message: "Status must be ACTIVE or PAUSED", requestId: randomUUID() });
        }
        // Resuming makes the monitor count against the entitlement again, so
        // it is checked like creating one — including a monitor the plan
        // paused (ENTITLEMENT_PAUSED): its owner can resume it once the plan
        // has room, never past it. Checked before anything is written.
        const running = monitor.status === "ACTIVE" || monitor.status === "DEGRADED";
        if (status === "ACTIVE" && !running) {
          const monitorLimit = await entitlements.limit(user.id, "monitors.active");
          const active = await monitorRepo.countActiveForUser(user.id);
          if (active >= monitorLimit) {
            return reply.code(429).send({
              code: "MONITOR_LIMIT_REACHED",
              message: `Monitor limit reached (${monitorLimit} active)`,
              requestId: randomUUID()
            });
          }
        }
      }
      if (scheduleType !== undefined) {
        if (!allowedSchedules().includes(scheduleType)) {
          return reply.code(400).send({ code: "INVALID_SCHEDULE", message: `Schedule must be one of: ${allowedSchedules().join(", ")}`, requestId: randomUUID() });
        }
        await monitorRepo.updateSchedule(user.id, monitor.id, scheduleType, new Date(Date.now() + scheduleIntervalMs(scheduleType)).toISOString());
      }
      if (status !== undefined) {
        await monitorRepo.setStatus(user.id, monitor.id, status);
      }
      if (alertRules && typeof alertRules === "object") {
        const patch: Record<string, unknown> = {};
        const severities = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
        if (typeof alertRules.minimumSeverity === "string") {
          if (!severities.includes(alertRules.minimumSeverity)) {
            return reply.code(400).send({ code: "INVALID_SEVERITY", message: `Severity must be one of: ${severities.join(", ")}`, requestId: randomUUID() });
          }
          patch.minimum_severity = alertRules.minimumSeverity;
        }
        if (typeof alertRules.minimumConfidence === "number") patch.minimum_confidence = String(Math.min(1, Math.max(0, alertRules.minimumConfidence)));
        if (typeof alertRules.overallScoreDeltaThreshold === "number") patch.overall_score_delta_threshold = alertRules.overallScoreDeltaThreshold;
        if (typeof alertRules.notifyNewEntity === "boolean") patch.notify_new_entity = alertRules.notifyNewEntity;
        if (typeof alertRules.notifyNewAttackPath === "boolean") patch.notify_new_attack_path = alertRules.notifyNewAttackPath;
        if (typeof alertRules.notifyBehaviorChange === "boolean") patch.notify_behavior_change = alertRules.notifyBehaviorChange;
        if (typeof alertRules.notifyDataQualityDegraded === "boolean") patch.notify_data_quality_degraded = alertRules.notifyDataQualityDegraded;
        if (typeof alertRules.cooldownHours === "number") patch.cooldown_hours = alertRules.cooldownHours;
        // D6-F §76: correlation alert knobs.
        if (typeof alertRules.notifyCorrelationChange === "boolean") patch.notify_correlation_change = alertRules.notifyCorrelationChange;
        if (typeof alertRules.correlationMinScore === "number") patch.correlation_min_score = Math.max(0, Math.min(100, alertRules.correlationMinScore));
        if (typeof alertRules.correlationMinConfidence === "number") patch.correlation_min_confidence = String(Math.min(1, Math.max(0, alertRules.correlationMinConfidence)));
        await alertRulesRepo.updateForMonitor(monitor.id, patch);
      }

      const updated = await monitorRepo.getForUser(user.id, monitor.id);
      const rules = await alertRulesRepo.getForMonitor(monitor.id);
      return reply.send({ monitor: updated, rules });
    }
  );

  app.delete<{ Params: { id: string } }>("/v1/me/monitors/:id", async (req, reply) => {
    const gate = monitorGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const monitor = await monitorRepo.getRowForUser(user.id, req.params.id);
    if (!monitor) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Monitor not found", requestId: randomUUID() });
    }
    // Soft-disable: history (events/checks) stays inspectable, scheduling stops.
    await monitorRepo.setStatus(user.id, monitor.id, "DISABLED");
    return reply.send({ disabled: true });
  });

  app.get<{ Params: { id: string } }>("/v1/me/monitors/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const monitor = await monitorRepo.getForUser(user.id, req.params.id);
    if (!monitor) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Monitor not found", requestId: randomUUID() });
    }
    const [rules, events, checks, diffs, correlationEvents] = await Promise.all([
      alertRulesRepo.getForMonitor(monitor.id),
      threatEventRepo.listForMonitor(monitor.id, 20),
      monitorCheckRepo.listForMonitor(monitor.id, 20),
      diffRepo.listForMonitor(monitor.id, 20),
      createMonitorCorrelationRepo(sql).listEventsForMonitor(monitor.id, 20)
    ]);
    return reply.send({ monitor, rules, events, checks, diffs, correlationEvents });
  });

  app.get<{ Params: { id: string } }>("/v1/me/monitors/:id/events", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const monitor = await monitorRepo.getRowForUser(user.id, req.params.id);
    if (!monitor) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Monitor not found", requestId: randomUUID() });
    }
    const events = await threatEventRepo.listForMonitor(monitor.id, 50);
    return reply.send({ events });
  });

  app.post<{ Params: { id: string } }>("/v1/me/events/:id/acknowledge", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const acknowledged = await threatEventRepo.acknowledge(user.id, req.params.id);
    if (!acknowledged) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Event not found", requestId: randomUUID() });
    }
    return reply.send({ acknowledged: true });
  });

  app.get<{ Params: { id: string } }>("/v1/me/monitors/:id/compare", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const monitor = await monitorRepo.getRowForUser(user.id, req.params.id);
    if (!monitor) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Monitor not found", requestId: randomUUID() });
    }
    const diffs = await diffRepo.listForMonitor(monitor.id, 1);
    const diff = diffs[0];
    if (!diff) {
      return reply.code(404).send({ code: "NO_DIFF", message: "No comparison available yet", requestId: randomUUID() });
    }
    const previous = await jobRepo.findById(diff.previous_analysis_id);
    const current = await jobRepo.findById(diff.current_analysis_id);
    return reply.send({ diff, previous, current });
  });

  // ---- Notifications inbox, see milestone D4 (D4-F §49) ----
  // D6-I1: notification-email destination (optional, verified; email ≠ identity).

  registerNotificationEmailRoutes({
    app,
    sql,
    config,
    logger,
    requireUser
  });

  app.get<{ Querystring: { limit: number; cursor?: string; unread: boolean; severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"; channel: "IN_APP" } }>("/v1/me/notifications", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          cursor: { type: "string", minLength: 1, maxLength: 512 },
          unread: { type: "boolean", default: false },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] },
          channel: { type: "string", enum: ["IN_APP"], default: "IN_APP" }
        }
      }
    }
  }, async (req, reply) => {
    const gate = monitorGate(reply);
    if (gate) return gate;
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    await auth.ensureProfile(user, sql);
    let cursor;
    try {
      cursor = req.query.cursor ? decodeNotificationCursor(req.query.cursor) : undefined;
    } catch {
      const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Invalid notification cursor" }, meta: { requestId } });
    }
    const [result, unreadCount] = await Promise.all([
      notificationRepo.listForUserFiltered(user.id, {
        limit: req.query.limit,
        cursor,
        unreadOnly: req.query.unread,
        severity: req.query.severity
      }),
      notificationRepo.unreadCount(user.id)
    ]);
    return reply.send({ notifications: result.notifications, unreadCount, nextCursor: result.nextCursor });
  });

  app.post("/v1/me/notifications/read-all", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const count = await notificationRepo.markAllRead(user.id);
    return reply.send({ marked: count });
  });

  app.post<{ Params: { id: string } }>("/v1/me/notifications/:id/read", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
    const read = await notificationRepo.markRead(user.id, req.params.id);
    if (!read) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "Notification not found", requestId: randomUUID() });
    }
    return reply.send({ read: true });
  });

  // Test-only manual trigger, see milestone D4 §94: never exposed in production.
  if (config.NODE_ENV !== "production") {
    app.post<{ Params: { id: string } }>("/v1/me/monitors/:id/check", async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user || user.isAnonymous) return;
      const monitor = await monitorRepo.getRowForUser(user.id, req.params.id);
      if (!monitor) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Monitor not found", requestId: randomUUID() });
      }
      const now = new Date().toISOString();
      const check = await monitorCheckRepo.insert({ monitorId: monitor.id, scheduledFor: now });
      await monitorCheckRepo.markStarted(check.id);
      const latest = await jobRepo.latestForWallet(monitor.wallet_id);
      if (latest && latest.fresh_until && new Date(latest.fresh_until) > new Date()) {
        await monitorCheckRepo.markCompleted(check.id, { status: "REUSED", analysisId: latest.id, reused: true, previousAnalysisId: monitor.last_analysis_id });
        return reply.send({ check, reused: true, analysisId: latest.id });
      }
      const job = await jobRepo.create({
        walletId: monitor.wallet_id,
        requestedBy: monitor.user_id,
        analysisType: "full",
        priority: "free"
      });
      await monitorCheckRepo.markCompleted(check.id, { status: "IN_PROGRESS", analysisId: job.id, reused: false, previousAnalysisId: monitor.last_analysis_id });
      const wallet = await walletRepo.findById(monitor.wallet_id);
      const queue = queueForPriority("free", queues);
      await queue.add(
        "analyze",
        { analysisId: job.id, walletAddress: wallet?.address ?? "", chain: "solana", analysisType: "full" },
        { jobId: `analysis-${job.id}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } }
      );
      return reply.code(202).send({ check, analysisId: job.id });
    });
  }

  return app;
}

function buildXRayResponse(input: {
  address: string;
  job: AnalysisJobRow;
  score: ScoreRow | null;
  signals: SignalRow[];
  paths: Array<{ id: string; rank: number; path_type: string; nodes_json: unknown; edges_json: unknown; path_score: number; confidence_score: number; summary: string | null }>;
}) {
  const { address, job, score, signals, paths } = input;
  const dataQuality = (job.data_quality ?? {}) as Record<string, unknown>;

  const topSignals = signals.slice(0, 5).map((s) => ({
    type: s.signal_type,
    category: s.category,
    severity: s.severity,
    confidence: Number(s.confidence),
    title: s.title,
    summary: s.summary,
    evidence: (s.evidence_json as Array<{ key: string; value: string | number | boolean; label: string }>) ?? [],
    explanation: explainSignal(toIntelligenceSignal(s))
  }));

  return {
    analysis: {
      id: job.id,
      status: job.status,
      createdAt: job.requested_at,
      completedAt: job.completed_at,
      engineVersion: job.engine_version,
      chainDataUntil: job.chain_data_until,
      freshUntil: job.fresh_until
    },
    wallet: { address },
    coverage: {
      ...dataQuality,
      dataQualityScore: typeof dataQuality.dataQualityScore === "number" ? dataQuality.dataQualityScore : null,
      grade: typeof dataQuality.grade === "string" ? dataQuality.grade : null,
      transactionsAnalyzed: dataQuality.transactionsParsed ?? 0,
      historyCoverageDays: coverageDays(dataQuality)
    },
    score: score
      ? {
          overall: score.overall_score,
          confidence: Number(score.overall_confidence),
          scoringVersion: score.scoring_version
        }
      : null,
    dimensions: scoreDimensions(score),
    topSignals,
    relationships: [],
    entities: [],
    behavior: {},
    attackPaths: paths.map((p) => ({
      rank: p.rank,
      pathType: p.path_type,
      nodes: p.nodes_json,
      edges: p.edges_json,
      pathScore: p.path_score,
      confidence: p.confidence_score,
      summary: p.summary,
      explanation: explainPath({
        nodes: ((p.nodes_json as Array<{ type: string; label: string }>) ?? []).map((n) => ({ type: n.type, label: n.label })),
        pathScore: p.path_score,
        confidenceScore: p.confidence_score
      })
    })),
    engineVersions: {
      pipeline: job.engine_version,
      scoring: score?.scoring_version ?? null
    }
  };
}

/** Signal rows as the engines' own type, so consumers never see column names. */
function toIntelligenceSignal(s: SignalRow): IntelligenceSignal {
  return {
    type: s.signal_type,
    category: s.category as IntelligenceSignal["category"],
    severity: s.severity,
    confidence: Number(s.confidence),
    title: s.title,
    summary: s.summary ?? "",
    evidence: (s.evidence_json as IntelligenceSignal["evidence"]) ?? [],
    engineVersion: s.engine_version ?? ""
  };
}

/** One definition of the dimension labels, shared by X-Ray and context. */
function scoreDimensions(score: ScoreRow | null): Array<{ key: string; label: string; score: number }> {
  if (!score) return [];
  return [
    { key: "identityLinkability", label: "Identity Linkability", score: score.identity_linkability },
    { key: "fundingExposure", label: "Funding Exposure", score: score.funding_exposure },
    { key: "walletClusterExposure", label: "Wallet Cluster Exposure", score: score.wallet_cluster_exposure },
    { key: "behavioralFingerprint", label: "Behavioral Fingerprint", score: score.behavioral_fingerprint },
    { key: "counterpartyExposure", label: "Counterparty Exposure", score: score.counterparty_exposure },
    { key: "entityExposure", label: "Entity Exposure", score: score.entity_exposure },
    { key: "transactionPatternExposure", label: "Transaction Pattern Exposure", score: score.transaction_pattern_exposure }
  ];
}

function coverageDays(dataQuality: Record<string, unknown>): number | null {
  const start = dataQuality.historyStart;
  const end = dataQuality.historyEnd;
  if (typeof start !== "string" || typeof end !== "string") return null;
  return Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000));
}

/** Deterministic, non-reversible wallet reference for logs (§127). */
function hashWalletForLog(wallet: string): string {
  return createHash("sha256").update(wallet, "utf8").digest("hex").slice(0, 16);
}
