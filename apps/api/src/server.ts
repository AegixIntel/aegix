import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "@aegix/config";
import { isValidSolanaAddress } from "@aegix/blockchain";
import { createDb, createAnalysisJobRepo, createWalletRepo } from "@aegix/database";
import { createCache } from "@aegix/cache";
import { createQueues, queueForPriority } from "@aegix/queue";
import type { AnalysisJob } from "@aegix/types";

export interface ApiDeps {
  config: AppConfig;
}

export async function buildServer(deps: ApiDeps) {
  const { config } = deps;
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  await app.register(cors, { origin: config.CORS_ORIGIN.split(",") });
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute"
  });

  const sql = createDb(config.DATABASE_URL);
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  const queues = createQueues(config);

  app.addHook("onClose", async () => {
    await queues.close();
    await sql.end();
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async () => {
    // Lightweight dependency probe; fails fast when DB/Redis are down
    await sql`select 1`;
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

      // Cache lookup: return cached analysis if fresh
      const cached = await cache.getJson<{ analysisId: string }>(`analysis:${address}`);
      if (cached?.analysisId) {
        return reply.send({ analysisId: cached.analysisId, cached: true });
      }

      const wallet = await walletRepo.findOrCreate("solana", address);
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
        { jobId: `analysis:${job.id}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } }
      );

      await cache.setJson(`analysis:${address}`, { analysisId: job.id }, config.ANALYSIS_CACHE_TTL_SECONDS);

      reply.code(202).send({
        analysisId: job.id,
        status: job.status,
        walletAddress: address
      });
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

  return app;
}
