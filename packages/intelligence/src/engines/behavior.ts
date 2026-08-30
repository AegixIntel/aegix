import type { IntelligenceSignal, NormalizedProgramInteraction, NormalizedTransaction } from "@aegix/types";
import { makeSignal } from "../signals.js";

export const BEHAVIOR_ENGINE_VERSION = "behavior-v1.0.0";

export interface BehaviorAnalysisInput {
  walletAddress: string;
  transactions: NormalizedTransaction[];
  interactions: NormalizedProgramInteraction[];
}

export interface BehaviorAnalysisResult {
  signals: IntelligenceSignal[];
  features: Record<string, number | Record<string, number>>;
  activityHourDistribution: Record<number, number>;
  weekdayDistribution: Record<number, number>;
  protocolDistribution: Record<string, number>;
  transferSizeDistribution: Record<string, number>;
  txIntervalDistribution: Record<string, number>;
}

const HOUR_BUCKETS = 24;
const WEEKDAY_BUCKETS = 7;

/**
 * Behavioral engine, see architecture.md §55.
 * Computes time-of-day, day-of-week, protocol and transfer size distributions.
 */
export function analyzeBehavior(input: BehaviorAnalysisInput): BehaviorAnalysisResult {
  const { transactions, interactions } = input;

  const activityHourDistribution: Record<number, number> = {};
  const weekdayDistribution: Record<number, number> = {};
  const protocolDistribution: Record<string, number> = {};
  const transferSizeDistribution: Record<string, number> = {};
  const txIntervalDistribution: Record<string, number> = {};

  const timestamps = transactions.map((t) => new Date(t.blockTime).getTime()).sort((a, b) => a - b);

  for (const ts of timestamps) {
    const d = new Date(ts);
    const hour = d.getUTCHours();
    const weekday = d.getUTCDay();
    activityHourDistribution[hour] = (activityHourDistribution[hour] ?? 0) + 1;
    weekdayDistribution[weekday] = (weekdayDistribution[weekday] ?? 0) + 1;
  }

  for (const ix of interactions) {
    const key = ix.programLabel ?? ix.protocolCategory;
    protocolDistribution[key] = (protocolDistribution[key] ?? 0) + 1;
  }

  for (const t of transactions) {
    for (const transfer of t.transfers) {
      const bucket = bucketForValue(transfer.amountNormalized);
      transferSizeDistribution[bucket] = (transferSizeDistribution[bucket] ?? 0) + 1;
    }
  }

  for (let i = 1; i < timestamps.length; i++) {
    const intervalHours = (timestamps[i]! - timestamps[i - 1]!) / 3_600_000;
    const bucket = intervalHours < 1 ? "<1h" : intervalHours < 6 ? "1-6h" : intervalHours < 24 ? "6-24h" : intervalHours < 168 ? "1-7d" : ">7d";
    txIntervalDistribution[bucket] = (txIntervalDistribution[bucket] ?? 0) + 1;
  }

  const totalTx = transactions.length;
  const activeHours = Object.keys(activityHourDistribution).length;
  const uniqueProtocols = Object.keys(protocolDistribution).length;

  const signals: IntelligenceSignal[] = [];

  if (totalTx > 0 && activeHours <= 6) {
    signals.push(
      makeSignal(
        {
          type: "NARROW_ACTIVITY_WINDOW",
          category: "BEHAVIORAL",
          severity: 45,
          confidence: 0.65,
          title: "Narrow activity window",
          summary: `Activity concentrates in ${activeHours} distinct hours, which can be a fingerprinting signal.`,
          evidence: [
            { key: "active_hours", value: activeHours, label: "Distinct active hours" },
            { key: "total_transactions", value: totalTx, label: "Transactions" }
          ]
        },
        BEHAVIOR_ENGINE_VERSION
      )
    );
  }

  if (uniqueProtocols === 1 && totalTx >= 5) {
    signals.push(
      makeSignal(
        {
          type: "SINGLE_PROTOCOL_USE",
          category: "BEHAVIORAL",
          severity: 30,
          confidence: 0.7,
          title: "Single protocol usage",
          summary: "All activity flows through a single protocol, a distinctive behavioral pattern.",
          evidence: [
            { key: "protocol", value: Object.keys(protocolDistribution)[0] ?? "unknown", label: "Protocol" },
            { key: "count", value: totalTx, label: "Transactions" }
          ]
        },
        BEHAVIOR_ENGINE_VERSION
      )
    );
  }

  const features: Record<string, number | Record<string, number>> = {
    txPerDay: totalTx > 0 ? Math.round((totalTx / Math.max(1, daysCovered(timestamps))) * 100) / 100 : 0,
    activeHours,
    uniqueProtocols,
    activityHourDistribution,
    weekdayDistribution,
    protocolDistribution,
    transferSizeDistribution,
    txIntervalDistribution
  };

  return {
    signals,
    features,
    activityHourDistribution,
    weekdayDistribution,
    protocolDistribution,
    transferSizeDistribution,
    txIntervalDistribution
  };
}

function daysCovered(timestamps: number[]): number {
  if (timestamps.length < 2) return 1;
  return Math.max(1, (timestamps[timestamps.length - 1]! - timestamps[0]!) / 86_400_000);
}

function bucketForValue(value: number): string {
  if (value < 0.01) return "<0.01";
  if (value < 1) return "0.01-1";
  if (value < 10) return "1-10";
  if (value < 100) return "10-100";
  if (value < 1000) return "100-1k";
  return ">1k";
}
