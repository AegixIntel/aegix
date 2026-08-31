import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import type { AppConfig } from "@aegix/config";
import {
  classifyAddress,
  createProviderPoolFromConfig,
  isAnalysisEligible,
  isValidSolanaAddress,
  type AccountClassification
} from "@aegix/blockchain";
import { createLogger, walletRef } from "@aegix/logging";
import {
  createAnalysisJobRepo,
  createDb,
  createIntelligenceRepo,
  createSavedAnalysisRepo,
  createWalletRepo,
  type AnalysisJobRow,
  type ScoreRow,
  type SignalRow
} from "@aegix/database";
import { createCache } from "@aegix/cache";
import { createQueues, queueForPriority } from "@aegix/queue";
import { explainPath, explainSignal } from "@aegix/explanation";
import { createAuth, requireUser, type AuthUser } from "./auth.js";
import { checkQuota, recordCacheHit, recordQuotaUsage, type QuotaContext } from "./quota.js";
import type { IntelligenceSignal } from "@aegix/types";

export interface ApiDeps {
  config: AppConfig;
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
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  const logger = createLogger(config, { service: "api" });

  await app.register(cors, { origin: config.CORS_ORIGIN.split(",") });
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute"
  });

  // Analysis trace, see D2 §56: every API request carries a request_id that
  // flows into job records. Full wallet addresses are never logged.
  const auth = createAuth(config);
  app.addHook("onRequest", async (req) => {
    const requestId = randomUUID();
    req.headers["x-request-id"] = requestId;
    const address = (req.params as { address?: string })?.address ?? (req.body as { address?: string } | null)?.address;
    const ctx = { requestId, method: req.method, path: req.routeOptions?.url ?? req.url, ...(address ? walletRef(address) : {}) };
    logger.info("request started", ctx);
    // Server-side auth resolution, see D3-D §29: never trust frontend claims.
    req.user = await auth.resolveUser(req);
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

  const sql = createDb(config.DATABASE_URL);
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const savedRepo = createSavedAnalysisRepo(sql);
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  const queues = createQueues(config);
  const provider = createProviderPoolFromConfig(config);

  app.addHook("onClose", async () => {
    await queues.close();
    await cache.close();
    await sql.end();
  });

  app.get("/health/live", async () => ({ status: "ok" }));

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

  app.get("/health/ready", async () => {
    await sql`select 1`;
    await cache.get("health:probe");
    return { status: "ok" };
  });

  app.post<{ Body: { address: string } }>(
    "/v1/analyses",
    {
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

      const engineVersion = "aegix-pipeline-v1.0.0";

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
        const quota = await checkQuota(sql, config, quotaContext(req));
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
    const latest = await jobRepo.latestForWallet(wallet.id);
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

    return reply.send(buildXRayResponse({ address, job: latest, score, signals, paths }));
  });

  // ---- Saved analyses (authenticated), see D3-E §31-§33 and D3-G §38 ----

  app.get("/v1/me/saved", async (req, reply) => {
    if (!config.ENABLE_SAVE_WALLET) {
      return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Saving wallets is disabled", requestId: randomUUID() });
    }
    const user = await requireUser(req, reply);
    if (!user || user.isAnonymous) return;
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
    explanation: explainSignal({
      type: s.signal_type,
      category: s.category as IntelligenceSignal["category"],
      severity: s.severity,
      confidence: Number(s.confidence),
      title: s.title,
      summary: s.summary ?? "",
      evidence: (s.evidence_json as Array<{ key: string; value: string | number | boolean; label: string }>) ?? [],
      engineVersion: s.engine_version ?? ""
    })
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
    dimensions: score
      ? [
          { key: "identityLinkability", label: "Identity Linkability", score: score.identity_linkability },
          { key: "fundingExposure", label: "Funding Exposure", score: score.funding_exposure },
          { key: "walletClusterExposure", label: "Wallet Cluster Exposure", score: score.wallet_cluster_exposure },
          { key: "behavioralFingerprint", label: "Behavioral Fingerprint", score: score.behavioral_fingerprint },
          { key: "counterpartyExposure", label: "Counterparty Exposure", score: score.counterparty_exposure },
          { key: "entityExposure", label: "Entity Exposure", score: score.entity_exposure },
          { key: "transactionPatternExposure", label: "Transaction Pattern Exposure", score: score.transaction_pattern_exposure }
        ]
      : [],
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

function coverageDays(dataQuality: Record<string, unknown>): number | null {
  const start = dataQuality.historyStart;
  const end = dataQuality.historyEnd;
  if (typeof start !== "string" || typeof end !== "string") return null;
  return Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000));
}
