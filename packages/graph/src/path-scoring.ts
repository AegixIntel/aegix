import { DEFAULT_GRAPH_LIMITS } from "@aegix/types";
import type { ExposurePath } from "@aegix/types";

/**
 * Relationship strength model, see architecture.md §20.
 * Combines frequency, recency, value, exclusivity and direction into a 0-1 score.
 */
export function relationshipStrength(input: {
  transactionCount: number;
  daysSinceLastSeen: number;
  totalValue: number;
  maxTotalValue: number;
  counterpartyCount: number;
  bidirectional: boolean;
}): number {
  const frequencyWeight = Math.min(1, input.transactionCount / 20) * 0.3;
  const recencyWeight = Math.max(0, 1 - input.daysSinceLastSeen / 90) * 0.2;
  const valueWeight = input.maxTotalValue > 0 ? Math.min(1, input.totalValue / input.maxTotalValue) * 0.25 : 0;
  const exclusivityWeight = Math.min(1, 5 / Math.max(1, input.counterpartyCount)) * 0.15;
  const directionWeight = (input.bidirectional ? 1 : 0.6) * 0.1;

  return clamp(frequencyWeight + recencyWeight + valueWeight + exclusivityWeight + directionWeight, 0, 1);
}

/**
 * Path confidence, see architecture.md §33.
 * Minimum edge confidence scaled by data completeness.
 */
export function pathConfidence(edgeConfidences: number[], dataCompleteness: number): number {
  if (edgeConfidences.length === 0) return 0;
  const minEdge = Math.min(...edgeConfidences);
  return clamp(minEdge * clamp(dataCompleteness, 0, 1), 0, 1);
}

export function rankPaths(paths: ExposurePath[], limit = 10): ExposurePath[] {
  return [...paths].sort((a, b) => b.pathScore - a.pathScore).slice(0, limit);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export { DEFAULT_GRAPH_LIMITS };
