import { Queue } from "bullmq";
import type { AppConfig } from "@aegix/config";

/**
 * Standardized error taxonomy, see milestone D2 §62.
 * Workers and API map failures to these codes so downstream consumers
 * (UI, DLQ records, monitoring) can reason about failure classes.
 */
export type ErrorCode =
  | "INVALID_WALLET"
  | "INSUFFICIENT_HISTORY"
  | "CHAIN_DATA_UNAVAILABLE"
  | "RPC_RATE_LIMITED"
  | "RPC_TIMEOUT"
  | "RPC_UNAVAILABLE"
  | "FETCH_INCOMPLETE"
  | "PARSER_FAILURE"
  | "DATA_QUALITY_LOW"
  | "ANALYSIS_TIMEOUT"
  | "ENGINE_FAILURE"
  | "GRAPH_BUDGET_EXCEEDED"
  | "DATABASE_FAILURE"
  | "QUEUE_FAILURE"
  | "INTERNAL_ERROR";

/** Maps an unknown error to the closest taxonomy code. */
export function classifyError(err: unknown): ErrorCode {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.toLowerCase();
  if (m.includes("429") || m.includes("rate limit") || m.includes("too many requests")) return "RPC_RATE_LIMITED";
  if (m.includes("timeout") || m.includes("timed out") || m.includes("etimedout")) return "RPC_TIMEOUT";
  if (m.includes("unavailable") || m.includes("econnrefused") || m.includes("socket hang up") || m.includes("network")) return "RPC_UNAVAILABLE";
  if (m.includes("invalid wallet") || m.includes("invalid address")) return "INVALID_WALLET";
  if (m.includes("parser") || m.includes("normalize")) return "PARSER_FAILURE";
  if (m.includes("database") || m.includes("db ") || m.includes("postgres") || m.includes("connection refused")) return "DATABASE_FAILURE";
  if (m.includes("queue") || m.includes("redis")) return "QUEUE_FAILURE";
  return "INTERNAL_ERROR";
}

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

/**
 * Monitoring queue payloads, see docs/milestone-d4.md (D4-B).
 * - check: scheduler sweep tick, or a per-monitor run (deterministic jobId).
 * - diff: analysis-complete fan-out to the wallet's monitors (D4-I §75).
 * - deliver: notification delivery attempt (D4-F §53-§54).
 */
export type MonitoringJobData =
  | { kind: "check"; monitorId?: string; walletId?: string }
  | { kind: "diff"; analysisId: string; walletId: string }
  | { kind: "deliver"; notificationId: string };

export type QueueDataMap = {
  "analysis.high": AnalysisJobData;
  "analysis.standard": AnalysisJobData;
  "analysis.free": AnalysisJobData;
  refresh: RefreshJobData;
  monitoring: MonitoringJobData;
  "entity-refresh": never;
  "report-generation": { analysisId: string };
  maintenance: never;
  "dead-letter": {
    jobId: string;
    analysisId: string | null;
    walletShort: string | null;
    walletHash: string | null;
    originalQueue: string;
    stage: string;
    errorCode: ErrorCode;
    error: string;
    attempts: number;
    provider: string | null;
    timestamp: string;
  };
};

export type DeadLetterRecord = QueueDataMap["dead-letter"];

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

/**
 * Publishes a DLQ record, see milestone D2 §59.
 * A job that exhausts its retries must produce a dead-letter record so no
 * failure is silently lost. Never throws — DLQ publishing is best-effort.
 */
export async function publishToDeadLetter(queues: AegixQueues, record: DeadLetterRecord): Promise<void> {
  try {
    await queues.deadLetter.add("dead-letter", record, {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false
    });
  } catch {
    // DLQ must not crash the worker; the failure is already in the job event log
  }
}
