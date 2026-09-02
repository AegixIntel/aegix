import { loadConfig } from "@aegix/config";
import { createDb } from "@aegix/database";
import { createLogger, walletRef } from "@aegix/logging";
import { classifyError, createQueues, publishToDeadLetter, type DeadLetterRecord } from "@aegix/queue";
import { createWorker, type ProcessorContext } from "./worker.js";
import { processAnalysis } from "./processors/analysis.js";
import { processMonitorJob } from "./processors/monitoring.js";
import { processWebhookJob } from "./processors/webhooks.js";
import { registerMonitorScheduler } from "./scheduler.js";

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const logger = createLogger(config, { service: "worker" });
const queues = createQueues(config);

const ctx: ProcessorContext = { config, sql, logger, queues };

const analysisWorkers = [
  createWorker({ name: "analysis.high", concurrency: Math.max(1, config.ANALYSIS_WORKER_CONCURRENCY) }, processAnalysis, ctx),
  createWorker({ name: "analysis.standard", concurrency: Math.max(1, config.ANALYSIS_WORKER_CONCURRENCY) }, processAnalysis, ctx),
  createWorker({ name: "analysis.free", concurrency: Math.max(1, Math.floor(config.ANALYSIS_WORKER_CONCURRENCY / 2)) }, processAnalysis, ctx)
];

const monitorWorkers = [
  createWorker({ name: "monitoring", concurrency: Math.max(1, config.MONITOR_WORKER_CONCURRENCY) }, processMonitorJob, ctx)
];

const webhookWorkers = config.ENABLE_WEBHOOK_DELIVERY
  ? [createWorker({ name: "webhooks", concurrency: Math.max(1, config.WEBHOOK_WORKER_CONCURRENCY) }, processWebhookJob, ctx)]
  : [];

const allWorkers = [...analysisWorkers, ...monitorWorkers, ...webhookWorkers];

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("received shutdown signal, draining workers", { signal });
  await Promise.all(allWorkers.map((w) => w.close()));
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

// Monitoring queue failures also land in the DLQ (same generic handler shape).
monitorWorkers.forEach((w) => {
  w.on("failed", (job, err) => {
    try {
      const errorCode = classifyError(err);
      const record: DeadLetterRecord = {
        jobId: job?.id ?? "unknown",
        analysisId: null,
        walletShort: null,
        walletHash: null,
        originalQueue: w.name,
        stage: "worker",
        errorCode,
        error: err.message.slice(0, 500),
        attempts: job?.attemptsMade ?? 0,
        provider: null,
        timestamp: new Date().toISOString()
      };
      void publishToDeadLetter(queues, record);
      logger.error("monitor job failed", {
        queue: w.name,
        jobId: job?.id,
        kind: (job?.data as { kind?: string } | undefined)?.kind,
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

void registerMonitorScheduler(queues, config, logger);

logger.info("worker started", {
  queues: allWorkers.map((w) => w.name),
  concurrency: config.ANALYSIS_WORKER_CONCURRENCY
});
