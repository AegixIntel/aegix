import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "@aegix/config";
import { isValidSolanaAddress } from "@aegix/blockchain";
import {
  createAnalysisJobRepo,
  createDb,
  createIntelligenceRepo,
  createWalletRepo,
  type AnalysisJobRow,
  type ScoreRow,
  type SignalRow
} from "@aegix/database";
import { createCache } from "@aegix/cache";
import { createQueues, queueForPriority } from "@aegix/queue";
import { explainPath, explainSignal } from "@aegix/explanation";
import type { IntelligenceSignal } from "@aegix/types";

export interface ApiDeps {
  config: AppConfig;
}

const ENGINE_SCOPE = "full";
const CACHE_PREFIX = "analysis-result";

function analysisLockKey(address: string, engineVersion: string): string {
  return `analysis-lock:solana:${address}:${ENGINE_SCOPE}:${engineVersion}`;
}

export async function buildServer(deps: ApiDeps) {
  const { config } = deps;
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  await app.register(cors, { origin: config.CORS_ORIGIN.split(",") });
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute"
  });

  // Basic security headers, see architecture.md §80.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
  });

  const sql = createDb(config.DATABASE_URL);
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  const queues = createQueues(config);

  app.addHook("onClose", async () => {
    await queues.close();
    await sql.end();
  });

  app.get("/health/live", async () => ({ status: "ok" }));

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

      const engineVersion = "aegix-pipeline-v1.0.0";

      // 1. Fresh cached analysis? Return it immediately.
      const cached = await cache.getJson<{ analysisId: string }>(`${CACHE_PREFIX}:${address}`);
      if (cached?.analysisId) {
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

        const job = await jobRepo.create({
          walletId: wallet.id,
          requestedBy: null,
          analysisType: "full",
          priority: "standard"
        });

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
          walletAddress: address
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
