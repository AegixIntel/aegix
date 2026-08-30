import { loadConfig } from "@aegix/config";
import { createDb } from "@aegix/database";
import { createWorker, type ProcessorContext } from "./worker.js";
import { processAnalysis } from "./processors/analysis.js";

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);

const ctx: ProcessorContext = { config, sql };

const analysisWorkers = [
  createWorker({ name: "analysis.high", concurrency: Math.max(1, config.ANALYSIS_WORKER_CONCURRENCY) }, processAnalysis, ctx),
  createWorker({ name: "analysis.standard", concurrency: Math.max(1, config.ANALYSIS_WORKER_CONCURRENCY) }, processAnalysis, ctx),
  createWorker({ name: "analysis.free", concurrency: Math.max(1, Math.floor(config.ANALYSIS_WORKER_CONCURRENCY / 2)) }, processAnalysis, ctx)
];

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  await Promise.all(analysisWorkers.map((w) => w.close()));
  await sql.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason instanceof Error ? reason.message : reason);
});

analysisWorkers.forEach((w) => {
  w.on("failed", (job, err) => {
    try {
      console.error(`job ${job?.id} failed:`, err.message);
    } catch {
      // never crash on logging
    }
  });
  w.on("error", (err) => {
    try {
      console.error(`worker ${w.name} error:`, err.message);
    } catch {
      // never crash on logging
    }
  });
});

console.log(`worker started with ${analysisWorkers.length} queues (concurrency ${config.ANALYSIS_WORKER_CONCURRENCY})`);
