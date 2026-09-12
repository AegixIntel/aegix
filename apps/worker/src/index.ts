import { loadConfig } from "@aegix/config";
import { createDb } from "@aegix/database";
import { createLogger, walletRef } from "@aegix/logging";
import { classifyError, createQueues, publishToDeadLetter, type DeadLetterRecord } from "@aegix/queue";
import { createWorker, type ProcessorContext } from "./worker.js";
import { processAnalysis } from "./processors/analysis.js";
import { processMonitorJob } from "./processors/monitoring.js";
import { processWebhookJob } from "./processors/webhooks.js";
import { runBillingLifecycle } from "./processors/billing.js";
import { registerMonitorScheduler } from "./scheduler.js";
import { workerHeartbeatKey } from "./health.js";
import { isFinalJobFailure } from "./failure.js";

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
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let billingTimer: ReturnType<typeof setInterval> | null = null;
/** Billing boundaries are hourly at finest; a 5-minute sweep is ample. */
const BILLING_SWEEP_INTERVAL_MS = 300_000;
let schedulerReady = !config.ENABLE_MONITOR_SCHEDULER || !config.ENABLE_MONITORING;

async function writeHeartbeat(): Promise<boolean> {
  try {
    if (!schedulerReady) throw new Error("monitor scheduler is not registered");
    await sql`select 1`;
    await queues.monitoring.getJobCounts();
    const client = await queues.monitoring.client;
    await client.set(workerHeartbeatKey(config), String(Date.now()));
    return true;
  } catch (error) {
    logger.error("worker heartbeat failed", { error: error instanceof Error ? error.message : "dependency unavailable" });
    return false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("received shutdown signal, draining workers", { signal });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (billingTimer) clearInterval(billingTimer);
  const close = async () => {
    await Promise.all(allWorkers.map((w) => w.close()));
    await queues.close();
    await sql.end();
  };
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker shutdown timed out")), 25_000));
  try {
    await Promise.race([close(), timeout]);
    logger.info("worker shutdown complete", { signal });
    process.exit(0);
  } catch (error) {
    logger.error("worker shutdown failed", { signal, error: error instanceof Error ? error.message : "unknown" });
    process.exit(1);
  }
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
      if (isFinalJobFailure(job)) void publishToDeadLetter(queues, record);
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
      if (isFinalJobFailure(job)) void publishToDeadLetter(queues, record);
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

webhookWorkers.forEach((w) => {
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
      if (isFinalJobFailure(job)) void publishToDeadLetter(queues, record);
      logger.error("webhook job failed", {
        queue: w.name,
        jobId: job?.id,
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

try {
  // A process is not ready merely because it exists: every BullMQ consumer,
  // the scheduler, PostgreSQL, and Redis must be viable before heartbeat starts.
  await Promise.all(allWorkers.map((worker) => worker.waitUntilReady()));
  schedulerReady = await registerMonitorScheduler(queues, config, logger);
  if (!(await writeHeartbeat())) throw new Error("initial worker readiness check failed");
  heartbeatTimer = setInterval(() => void writeHeartbeat(), 10_000);
  // D11: subscriptions age on wall-clock boundaries, not on requests. The
  // sweep is cheap (an indexed scan of due rows) and idempotent across
  // replicas, so it runs on a plain interval rather than needing its own
  // queue. A failure is logged and retried on the next tick; it never fails
  // the heartbeat, because billing being late is not the product being down.
  if (config.ENABLE_BILLING) {
    billingTimer = setInterval(() => {
      void runBillingLifecycle({ config, sql, logger })
        .then((result) => {
          if (result.scanned > 0) logger.info("billing lifecycle sweep", { ...result });
        })
        .catch((error: unknown) => {
          logger.error("billing lifecycle sweep failed", { error: error instanceof Error ? error.message : "unknown" });
        });
    }, BILLING_SWEEP_INTERVAL_MS);
  }
  logger.info("worker started", {
    queues: allWorkers.map((w) => w.name),
    concurrency: config.ANALYSIS_WORKER_CONCURRENCY
  });
} catch (error) {
  logger.error("worker startup failed", { error: error instanceof Error ? error.message : "unknown" });
  await shutdown("STARTUP_FAILURE");
}
