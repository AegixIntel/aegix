/**
 * Data Quality Model v2, see milestone D2 §15-§16.
 *
 * A formal, normalized view of how much confidence AEGIX should have in the
 * dataset behind an analysis. This is NOT privacy exposure — it measures the
 * dataset, not the wallet.
 */

export interface DataQualityInput {
  transactionsRequested: number;
  transactionsReceived: number;
  transactionsParsed: number;
  parserFailures: number;
  rpcFailures: number;
  unknownProgramCount: number;
  programInteractionCount: number;
  historyStart: string | null;
  historyEnd: string | null;
  /** configured maximum history depth in days (0 = unbounded) */
  maxHistoryDays: number;
  /** configured maximum transactions per analysis */
  maxTransactions: number;
}

export interface DataQualityResult {
  /** 0-100, how much confidence to place in the dataset */
  dataQualityScore: number;
  /** 0-1 components */
  components: {
    historyCoverage: number;
    transactionCoverage: number;
    parserSuccess: number;
    rpcCompleteness: number;
    knownProgramRatio: number;
    sampleAdequacy: number;
  };
  grade: "HIGH" | "MEDIUM" | "LOW";
}

export function computeDataQuality(input: DataQualityInput): DataQualityResult {
  const { transactionsRequested, transactionsReceived, transactionsParsed, parserFailures, rpcFailures } = input;

  const parserSuccess =
    transactionsReceived > 0 ? Math.max(0, (transactionsReceived - parserFailures) / transactionsReceived) : 0;

  const rpcCompleteness =
    transactionsRequested > 0 ? Math.max(0, (transactionsRequested - rpcFailures) / transactionsRequested) : 0;

  const knownProgramRatio =
    input.programInteractionCount > 0
      ? Math.max(0, (input.programInteractionCount - input.unknownProgramCount) / input.programInteractionCount)
      : 0.5; // no program interactions observed: neutral

  const historyCoverage = coverageDays(input.historyStart, input.historyEnd, input.maxHistoryDays);
  const transactionCoverage =
    input.maxTransactions > 0 ? Math.min(1, transactionsParsed / input.maxTransactions) : 1;
  const sampleAdequacy = Math.min(1, transactionsParsed / 500);

  // Weighted combination — weights reflect relative importance for intelligence reliability
  const dataQualityScore = Math.round(
    clamp(
      100 *
        (0.25 * parserSuccess +
          0.2 * rpcCompleteness +
          0.2 * historyCoverage +
          0.15 * sampleAdequacy +
          0.1 * knownProgramRatio +
          0.1 * transactionCoverage),
      0,
      100
    )
  );

  const grade = dataQualityScore >= 75 ? "HIGH" : dataQualityScore >= 45 ? "MEDIUM" : "LOW";

  return {
    dataQualityScore,
    components: {
      historyCoverage,
      transactionCoverage,
      parserSuccess,
      rpcCompleteness,
      knownProgramRatio,
      sampleAdequacy
    },
    grade
  };
}

function coverageDays(start: string | null, end: string | null, maxDays: number): number {
  if (!start || !end) return 0;
  const days = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
  const normalized = Math.min(1, Math.max(0, days / Math.max(1, maxDays)));
  return normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
