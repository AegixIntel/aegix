import { loadConfig } from "@aegix/config";
import { createDb } from "@aegix/database";
import { createLogger, walletRef } from "@aegix/logging";
import { classifyError, createQueues, publishToDeadLetter, type DeadLetterRecord } from "@aegix/queue";
import { createWorker, type ProcessorContext } from "./worker.js";
import { processAnalysis } from "./processors/analysis.js";

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const logger = createLogger(config, { service: "worker" });
const queues = createQueues(config);

const ctx: ProcessorContext = { config, sql, logger };

const analysisWorkers = [
  createWorker({ name: "analysis.high", concurrency: Math.max(1, config.ANALYSIS_WORKER_CONCURRENCY) }, processAnalysis, ctx),
  createWorker({ name: "analysis.standard", concurrency: Math.max(1, config.ANALYSIS_WORKER_CONCURRENCY) }, processAnalysis, ctx),
  createWorker({ name: "analysis.free", concurrency: Math.max(1, Math.floor(config.ANALYSIS_WORKER_CONCURRENCY / 2)) }, processAnalysis, ctx)
];

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("received shutdown signal, draining workers", { signal });
  await Promise.all(analysisWorkers.map((w) => w.close()));
  await queues.close();
  await sql.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});

analysisWorkers.forEach((w) => {
  w.on("failed", (job, err) => {
    try {
      const data = job?.data as { analysisId?: string; walletAddress?: string } | undefined;
      const ref = data?.walletAddress ? walletRef(data.walletAddress) : { walletShort: null, walletHash: null };
      const errorCode = classifyError(err);
      const record: DeadLetterRecord = {
        jobId: job?.id ?? "unknown",
        analysisId: data?.analysisId ?? null,
        walletShort: ref.walletShort ?? null,
        walletHash: ref.walletHash ?? null,
        originalQueue: w.name,
        stage: "worker",
        errorCode,
        error: err.message.slice(0, 500),
        attempts: job?.attemptsMade ?? 0,
        provider: null,
        timestamp: new Date().toISOString()
      };
      void publishToDeadLetter(queues, record);
      logger.error("job failed", {
        queue: w.name,
        jobId: job?.id,
        analysisId: data?.analysisId,
        ...ref,
        errorCode,
        error: err.message
      });
    } catch {
      // never crash on logging
    }
  });
  w.on("error", (err) => {
    try {
      logger.error("worker error", { queue: w.name, error: err.message });
    } catch {
      // never crash on logging
    }
  });
});

logger.info("worker started", {
  queues: analysisWorkers.map((w) => w.name),
  concurrency: config.ANALYSIS_WORKER_CONCURRENCY
});
