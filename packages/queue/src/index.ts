import { Queue } from "bullmq";
import type { AppConfig } from "@aegix/config";

export type QueueName = "analysis.high" | "analysis.standard" | "analysis.free" | "refresh" | "monitoring" | "entity-refresh" | "report-generation" | "maintenance" | "dead-letter";

export interface AnalysisJobData {
  analysisId: string;
  walletAddress: string;
  chain: "solana";
  analysisType: "full" | "attack";
}

export interface RefreshJobData {
  walletAddress: string;
  chain: "solana";
}

export interface MonitoringJobData {
  walletId: string;
  chain: "solana";
}

export type QueueDataMap = {
  "analysis.high": AnalysisJobData;
  "analysis.standard": AnalysisJobData;
  "analysis.free": AnalysisJobData;
  refresh: RefreshJobData;
  monitoring: MonitoringJobData;
  "entity-refresh": never;
  "report-generation": { analysisId: string };
  maintenance: never;
  "dead-letter": { originalQueue: string; payload: unknown; error: string; attempts: number };
};

export interface AegixQueues {
  analysisHigh: Queue<AnalysisJobData>;
  analysisStandard: Queue<AnalysisJobData>;
  analysisFree: Queue<AnalysisJobData>;
  refresh: Queue<RefreshJobData>;
  monitoring: Queue<MonitoringJobData>;
  reportGeneration: Queue<{ analysisId: string }>;
  deadLetter: Queue<QueueDataMap["dead-letter"]>;
  close(): Promise<void>;
}

/**
 * BullMQ queue setup, see architecture.md §46.
 * Queues are ephemeral coordination state; job records live in PostgreSQL.
 */
export function createQueues(config: AppConfig): AegixQueues {
  const connection = {
    url: config.REDIS_URL,
    db: config.REDIS_QUEUE_DB
  };

  const defaults = { connection, prefix: config.QUEUE_PREFIX };

  const analysisHigh = new Queue<AnalysisJobData>("analysis.high", defaults);
  const analysisStandard = new Queue<AnalysisJobData>("analysis.standard", defaults);
  const analysisFree = new Queue<AnalysisJobData>("analysis.free", defaults);
  const refresh = new Queue<RefreshJobData>("refresh", defaults);
  const monitoring = new Queue<MonitoringJobData>("monitoring", defaults);
  const reportGeneration = new Queue<{ analysisId: string }>("report-generation", defaults);
  const deadLetter = new Queue<QueueDataMap["dead-letter"]>("dead-letter", defaults);

  return {
    analysisHigh,
    analysisStandard,
    analysisFree,
    refresh,
    monitoring,
    reportGeneration,
    deadLetter,
    async close() {
      await Promise.all([analysisHigh, analysisStandard, analysisFree, refresh, monitoring, reportGeneration, deadLetter].map((q) => q.close()));
    }
  };
}

export function queueForPriority(priority: string, queues: AegixQueues): Queue<AnalysisJobData> {
  switch (priority) {
    case "high":
      return queues.analysisHigh;
    case "free":
      return queues.analysisFree;
    default:
      return queues.analysisStandard;
  }
}
