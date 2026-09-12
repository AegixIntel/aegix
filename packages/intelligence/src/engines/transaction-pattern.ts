import type { IntelligenceSignal, NormalizedTransaction, NormalizedTransfer } from "@aegix/types";
import { makeSignal } from "../signals.js";

export const TRANSACTION_PATTERN_ENGINE_VERSION = "transaction-pattern-v1.0.0";

/**
 * Minimum sample sizes. Below these the corresponding measure is not
 * reported at all rather than reported weakly — a wallet with three
 * transfers has no meaningful amount distribution.
 *
 * `MIN_TRANSFERS_FOR_DISTRIBUTION` is exported because the wallet context
 * assembler suppresses the same statistical categories below it, and the two
 * thresholds must not drift apart.
 */
export const MIN_TRANSFERS_FOR_DISTRIBUTION = 5;
const MIN_TRANSACTIONS_FOR_FREQUENCY = 20;
const MIN_TRANSACTIONS_FOR_HOUR_SHARE = 10;
const MIN_INTERVALS_FOR_REGULARITY = 5;

/** A single transfer this many times the wallet's own median is distinctive. */
const LARGE_TRANSFER_MEDIAN_MULTIPLE = 20;
/** Upper anchor for scaling the large-transfer ratio to 0-100. */
const LARGE_TRANSFER_RATIO_CEILING = 50;
/** Transactions per day at which frequency alone is a strong fingerprint. */
const HIGH_FREQUENCY_TX_PER_DAY = 20;
const HIGH_FREQUENCY_CEILING = 50;
/**
 * Low-activity UTC band. This is a documented heuristic, not a claim about
 * the operator's local time: a wallet concentrated here is distinguishable
 * from the population baseline, which is all the score asserts.
 */
const ODD_HOUR_START_UTC = 0;
const ODD_HOUR_END_UTC = 6;
/** 6 of 24 hours — the share a uniformly active wallet would already show. */
const ODD_HOUR_BASE_SHARE = (ODD_HOUR_END_UTC - ODD_HOUR_START_UTC) / 24;
const ODD_HOUR_SIGNAL_SHARE = 0.5;

const REPEATED_AMOUNT_MIN_OCCURRENCES = 3;
const REPEATED_AMOUNT_SIGNAL_SHARE = 0.2;
/** Interval coefficient of variation at or below which activity reads as periodic. */
const REGULARITY_SIGNAL_THRESHOLD = 0.75;

export interface TransactionPatternAnalysisInput {
  walletAddress: string;
  transactions: NormalizedTransaction[];
  transfers: NormalizedTransfer[];
}

export interface TransactionPatternFeatures {
  transfersConsidered: number;
  medianTransferAmount: number;
  largestTransferAmount: number;
  /** largest / median, 1 when the distribution is flat. */
  largeTransferRatio: number;
  transactionsPerDay: number;
  /** 0-1 share of transactions inside the low-activity UTC band. */
  oddHourShare: number;
  /** 0-1 share of transfers whose exact raw amount repeats. */
  repeatedAmountShare: number;
  /** 0-1, where 1 is perfectly periodic activity. */
  intervalRegularity: number;
}

export interface TransactionPatternAnalysisResult {
  signals: IntelligenceSignal[];
  /** 0-100 components consumed directly by the scoring engine. */
  largeTransferExposure: number;
  highFrequencyExposure: number;
  oddHourExposure: number;
  regularIntervalExposure: number;
  features: TransactionPatternFeatures;
}

/**
 * Transaction pattern engine — the TRANSACTION_PATTERN signal category and
 * the `transactionPatternExposure` score dimension (architecture.md §26).
 *
 * Every component is measured against the wallet's own distribution and
 * exported as an explicit 0-100 value, so the scoring engine no longer has
 * to stand in a transaction-count proxy for "large transfers" or
 * "high frequency".
 */
export function analyzeTransactionPatterns(
  input: TransactionPatternAnalysisInput
): TransactionPatternAnalysisResult {
  const { transactions, transfers } = input;

  // Fees are protocol-imposed, not wallet behavior, and zero-value transfers
  // carry no amount information.
  const valued = transfers.filter((t) => t.transferType !== "FEE" && t.amountNormalized > 0);
  const amounts = valued.map((t) => t.amountNormalized).sort((a, b) => a - b);

  const medianTransferAmount = median(amounts);
  const largestTransferAmount = amounts.length > 0 ? amounts[amounts.length - 1]! : 0;
  const largeTransferRatio =
    amounts.length >= MIN_TRANSFERS_FOR_DISTRIBUTION && medianTransferAmount > 0
      ? largestTransferAmount / medianTransferAmount
      : 1;

  const timestamps = transactions
    .map((t) => new Date(t.blockTime).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  const transactionsPerDay = timestamps.length > 0 ? timestamps.length / daysCovered(timestamps) : 0;

  let oddHourCount = 0;
  for (const ms of timestamps) {
    const hour = new Date(ms).getUTCHours();
    if (hour >= ODD_HOUR_START_UTC && hour < ODD_HOUR_END_UTC) oddHourCount++;
  }
  const oddHourShare = timestamps.length > 0 ? oddHourCount / timestamps.length : 0;

  const amountCounts = new Map<string, number>();
  for (const t of valued) {
    amountCounts.set(t.amountRaw, (amountCounts.get(t.amountRaw) ?? 0) + 1);
  }
  let repeatedAmountCount = 0;
  let topRepeatedAmount: { amountRaw: string; occurrences: number } | null = null;
  for (const [amountRaw, occurrences] of amountCounts) {
    if (occurrences < REPEATED_AMOUNT_MIN_OCCURRENCES) continue;
    repeatedAmountCount += occurrences;
    if (!topRepeatedAmount || occurrences > topRepeatedAmount.occurrences) {
      topRepeatedAmount = { amountRaw, occurrences };
    }
  }
  const repeatedAmountShare = valued.length > 0 ? repeatedAmountCount / valued.length : 0;

  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i]! - timestamps[i - 1]!);
  }
  const intervalRegularity =
    intervals.length >= MIN_INTERVALS_FOR_REGULARITY ? regularityOf(intervals) : 0;

  const largeTransferExposure =
    amounts.length >= MIN_TRANSFERS_FOR_DISTRIBUTION
      ? scaleTo100(largeTransferRatio, 1, LARGE_TRANSFER_RATIO_CEILING)
      : 0;
  const highFrequencyExposure =
    timestamps.length >= MIN_TRANSACTIONS_FOR_FREQUENCY
      ? scaleTo100(transactionsPerDay, 0, HIGH_FREQUENCY_CEILING)
      : 0;
  const oddHourExposure =
    timestamps.length >= MIN_TRANSACTIONS_FOR_HOUR_SHARE
      ? scaleTo100(oddHourShare, ODD_HOUR_BASE_SHARE, 1)
      : 0;
  const regularIntervalExposure = Math.round(intervalRegularity * 100);

  const signals: IntelligenceSignal[] = [];

  if (
    amounts.length >= MIN_TRANSFERS_FOR_DISTRIBUTION &&
    largeTransferRatio >= LARGE_TRANSFER_MEDIAN_MULTIPLE
  ) {
    signals.push(
      makeSignal(
        {
          type: "LARGE_TRANSFER_OUTLIER",
          category: "TRANSACTION_PATTERN",
          severity: largeTransferExposure,
          confidence: 0.6,
          title: "Outlier transfer amount",
          summary: `The largest transfer is ${round2(largeTransferRatio)}× this wallet's median transfer, which makes it distinctive enough to follow across hops.`,
          evidence: [
            { key: "largest_transfer", value: round2(largestTransferAmount), label: "Largest transfer" },
            { key: "median_transfer", value: round2(medianTransferAmount), label: "Median transfer" },
            { key: "ratio", value: round2(largeTransferRatio), label: "Largest ÷ median" },
            { key: "transfers_considered", value: amounts.length, label: "Transfers considered" }
          ]
        },
        TRANSACTION_PATTERN_ENGINE_VERSION
      )
    );
  }

  if (
    timestamps.length >= MIN_TRANSACTIONS_FOR_FREQUENCY &&
    transactionsPerDay >= HIGH_FREQUENCY_TX_PER_DAY
  ) {
    signals.push(
      makeSignal(
        {
          type: "HIGH_FREQUENCY_ACTIVITY",
          category: "TRANSACTION_PATTERN",
          severity: highFrequencyExposure,
          confidence: 0.7,
          title: "High transaction frequency",
          summary: `Activity averages ${round2(transactionsPerDay)} transactions per day, a rate that narrows the set of comparable wallets.`,
          evidence: [
            { key: "transactions_per_day", value: round2(transactionsPerDay), label: "Transactions per day" },
            { key: "transactions", value: timestamps.length, label: "Transactions" },
            { key: "days_covered", value: round2(daysCovered(timestamps)), label: "Days covered" }
          ]
        },
        TRANSACTION_PATTERN_ENGINE_VERSION
      )
    );
  }

  if (timestamps.length >= MIN_TRANSACTIONS_FOR_HOUR_SHARE && oddHourShare >= ODD_HOUR_SIGNAL_SHARE) {
    signals.push(
      makeSignal(
        {
          type: "ODD_HOUR_CONCENTRATION",
          category: "TRANSACTION_PATTERN",
          severity: oddHourExposure,
          confidence: 0.55,
          title: "Activity concentrated in a low-activity window",
          summary: `${Math.round(oddHourShare * 100)}% of transactions fall in the ${ODD_HOUR_START_UTC}:00–${ODD_HOUR_END_UTC}:00 UTC band, against a ${Math.round(ODD_HOUR_BASE_SHARE * 100)}% baseline for uniform activity.`,
          evidence: [
            { key: "odd_hour_share", value: round2(oddHourShare), label: "Share in window" },
            { key: "baseline_share", value: round2(ODD_HOUR_BASE_SHARE), label: "Uniform baseline" },
            { key: "transactions", value: timestamps.length, label: "Transactions" }
          ]
        },
        TRANSACTION_PATTERN_ENGINE_VERSION
      )
    );
  }

  if (topRepeatedAmount && repeatedAmountShare >= REPEATED_AMOUNT_SIGNAL_SHARE) {
    signals.push(
      makeSignal(
        {
          type: "REPEATED_EXACT_AMOUNT",
          category: "TRANSACTION_PATTERN",
          severity: Math.round(40 + repeatedAmountShare * 30),
          confidence: 0.7,
          title: "Repeated exact transfer amounts",
          summary: `${Math.round(repeatedAmountShare * 100)}% of transfers reuse an exact amount. Identical amounts are one of the cheapest ways for an observer to correlate addresses.`,
          evidence: [
            { key: "repeated_amount_raw", value: topRepeatedAmount.amountRaw, label: "Most repeated raw amount" },
            { key: "occurrences", value: topRepeatedAmount.occurrences, label: "Occurrences" },
            { key: "repeated_share", value: round2(repeatedAmountShare), label: "Share of transfers" }
          ]
        },
        TRANSACTION_PATTERN_ENGINE_VERSION
      )
    );
  }

  if (intervals.length >= MIN_INTERVALS_FOR_REGULARITY && intervalRegularity >= REGULARITY_SIGNAL_THRESHOLD) {
    signals.push(
      makeSignal(
        {
          type: "REGULAR_INTERVAL_ACTIVITY",
          category: "TRANSACTION_PATTERN",
          severity: regularIntervalExposure,
          confidence: 0.6,
          title: "Periodic transaction intervals",
          summary: `Gaps between transactions are highly regular (regularity ${round2(intervalRegularity)}), consistent with scheduled or automated activity.`,
          evidence: [
            { key: "interval_regularity", value: round2(intervalRegularity), label: "Interval regularity" },
            { key: "intervals", value: intervals.length, label: "Intervals measured" },
            { key: "median_interval_hours", value: round2(median(intervals.slice().sort((a, b) => a - b)) / 3_600_000), label: "Median gap (hours)" }
          ]
        },
        TRANSACTION_PATTERN_ENGINE_VERSION
      )
    );
  }

  return {
    signals,
    largeTransferExposure,
    highFrequencyExposure,
    oddHourExposure,
    regularIntervalExposure,
    features: {
      transfersConsidered: amounts.length,
      medianTransferAmount: round2(medianTransferAmount),
      largestTransferAmount: round2(largestTransferAmount),
      largeTransferRatio: round2(largeTransferRatio),
      transactionsPerDay: round2(transactionsPerDay),
      oddHourShare: round2(oddHourShare),
      repeatedAmountShare: round2(repeatedAmountShare),
      intervalRegularity: round2(intervalRegularity)
    }
  };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function daysCovered(sortedTimestamps: number[]): number {
  if (sortedTimestamps.length < 2) return 1;
  const span = sortedTimestamps[sortedTimestamps.length - 1]! - sortedTimestamps[0]!;
  return Math.max(1, span / 86_400_000);
}

/**
 * Regularity as 1 - coefficient of variation of the intervals, clamped to
 * 0-1. Perfectly even gaps give 1; gaps as spread out as their own mean
 * give 0.
 */
function regularityOf(intervals: number[]): number {
  const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  if (mean <= 0) return 0;
  const variance = intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
  const cv = Math.sqrt(variance) / mean;
  return clamp(1 - cv, 0, 1);
}

/** Linear 0-100 scale between a lower and upper anchor. */
function scaleTo100(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  return Math.round(clamp((value - low) / (high - low), 0, 1) * 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
