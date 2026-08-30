import { Worker, type Job } from "bullmq";
import type { AppConfig } from "@aegix/config";
import type { AnalysisJobData, QueueName } from "@aegix/queue";
import type { Sql } from "@aegix/database";

export interface ProcessorContext {
  config: AppConfig;
  sql: Sql;
}

export type JobProcessor<T> = (job: Job<T>, ctx: ProcessorContext) => Promise<void>;

export interface WorkerOptions {
  name: QueueName;
  concurrency: number;
}

/** Creates a BullMQ worker for a named queue. */
export function createWorker<T>(options: WorkerOptions, processor: JobProcessor<T>, ctx: ProcessorContext): Worker<T> {
  return new Worker<T>(
    options.name,
    async (job) => {
      await processor(job, ctx);
    },
    {
      connection: { url: ctx.config.REDIS_URL, db: ctx.config.REDIS_QUEUE_DB },
      prefix: ctx.config.QUEUE_PREFIX,
      concurrency: options.concurrency
    }
  );
}

export type { AnalysisJobData, QueueName };
