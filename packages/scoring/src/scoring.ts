import type { Confidence, IntelligenceSignal, ScoreValue } from "@aegix/types";
import { DEFAULT_SCORING_CONFIG } from "./config.js";
import type { ScoringConfig } from "@aegix/types";

export const SCORING_ENGINE_VERSION = "scoring-v1.0.0";

export interface ScoreDimensionInput {
  repeatedFunding: number; // 0 – 100
  repeatedCounterparty: number; // 0 – 100
  knownEntityInteractions: number; // 0 – 100
  clusterLinks: number; // 0 – 100
  behavioralSignals: number; // 0 – 100
  counterpartyConcentration: number; // 0 – 1
  uniqueCounterparties: number;
  fundingConcentration: number; // 0 – 1
  transactionCount: number;
  historyDays: number;
  parserFailures: number;
  transactionsRequested: number;
  transactionsReceived: number;
}

export interface ScoreResult {
  overallScore: ScoreValue;
  dimensions: {
    identityLinkability: ScoreValue;
    fundingExposure: ScoreValue;
    walletClusterExposure: ScoreValue;
    behavioralFingerprint: ScoreValue;
    counterpartyExposure: ScoreValue;
    entityExposure: ScoreValue;
    transactionPatternExposure: ScoreValue;
  };
  overallConfidence: Confidence;
  scoringVersion: string;
}

/**
 * Privacy Exposure Score, see architecture.md §26-§28.
 * Each dimension is a weighted sum of normalized component values; the
 * overall score is the weighted sum of dimensions. Confidence is computed
 * separately from sample size, history depth, data completeness and
 * parser reliability.
 */
export function scoreWallet(input: ScoreDimensionInput, config: ScoringConfig = DEFAULT_SCORING_CONFIG): ScoreResult {
  const identityLinkability = weighted([
    [input.repeatedFunding, config.identityLinkability.repeated_funding ?? 0.3],
    [input.repeatedCounterparty, config.identityLinkability.repeated_counterparty ?? 0.3],
    [input.clusterLinks, config.identityLinkability.shared_counterparty ?? 0.2],
    [0, config.identityLinkability.public_attribution ?? 0.2]
  ]);

  const fundingExposure = weighted([
    [input.repeatedFunding, config.fundingExposure.repeated_funder ?? 0.25],
    [input.fundingConcentration * 100, config.fundingExposure.concentration ?? 0.2],
    [input.knownEntityInteractions, config.fundingExposure.known_entity ?? 0.2],
    [input.clusterLinks, config.fundingExposure.cross_wallet_reuse ?? 0.2],
    [input.behavioralSignals, config.fundingExposure.timing_pattern ?? 0.15]
  ]);

  const walletClusterExposure = weighted([
    [input.clusterLinks, config.walletClusterExposure.potential_cluster_link ?? 0.5],
    [input.clusterLinks, config.walletClusterExposure.shared_counterparty ?? 0.3],
    [input.behavioralSignals, config.walletClusterExposure.behavior_similarity ?? 0.2]
  ]);

  const behavioralFingerprint = weighted([
    [input.behavioralSignals, config.behavioralFingerprint.narrow_activity_window ?? 0.4],
    [input.behavioralSignals, config.behavioralFingerprint.single_protocol_use ?? 0.3],
    [input.behavioralSignals, config.behavioralFingerprint.regular_intervals ?? 0.3]
  ]);

  const counterpartyExposure = weighted([
    [input.repeatedCounterparty, config.counterpartyExposure.repeated_counterparty ?? 0.4],
    [input.counterpartyConcentration * 100, config.counterpartyExposure.dominant_counterparty ?? 0.3],
    [Math.min(100, input.uniqueCounterparties * 2), config.counterpartyExposure.unique_counterparties ?? 0.3]
  ]);

  const entityExposure = weighted([
    [input.knownEntityInteractions, config.entityExposure.known_entity_interaction ?? 0.6],
    [input.knownEntityInteractions, config.entityExposure.exchange_interaction ?? 0.4]
  ]);

  const transactionPatternExposure = weighted([
    [Math.min(100, input.transactionCount * 0.5), config.transactionPatternExposure.large_transfers ?? 0.4],
    [Math.min(100, input.transactionCount * 0.5), config.transactionPatternExposure.high_frequency ?? 0.3],
    [input.behavioralSignals, config.transactionPatternExposure.odd_hours ?? 0.3]
  ]);

  const dimensions = {
    identityLinkability,
    fundingExposure,
    walletClusterExposure,
    behavioralFingerprint,
    counterpartyExposure,
    entityExposure,
    transactionPatternExposure
  };

  const overallScore = weighted([
    [dimensions.identityLinkability, config.dimensionWeights.identityLinkability ?? 0.2],
    [dimensions.fundingExposure, config.dimensionWeights.fundingExposure ?? 0.2],
    [dimensions.walletClusterExposure, config.dimensionWeights.walletClusterExposure ?? 0.15],
    [dimensions.behavioralFingerprint, config.dimensionWeights.behavioralFingerprint ?? 0.15],
    [dimensions.counterpartyExposure, config.dimensionWeights.counterpartyExposure ?? 0.1],
    [dimensions.entityExposure, config.dimensionWeights.entityExposure ?? 0.1],
    [dimensions.transactionPatternExposure, config.dimensionWeights.transactionPatternExposure ?? 0.1]
  ]);

  const overallConfidence = computeConfidence(input);

  return {
    overallScore: Math.round(clamp(overallScore, 0, 100)),
    dimensions: {
      identityLinkability: Math.round(dimensions.identityLinkability),
      fundingExposure: Math.round(dimensions.fundingExposure),
      walletClusterExposure: Math.round(dimensions.walletClusterExposure),
      behavioralFingerprint: Math.round(dimensions.behavioralFingerprint),
      counterpartyExposure: Math.round(dimensions.counterpartyExposure),
      entityExposure: Math.round(dimensions.entityExposure),
      transactionPatternExposure: Math.round(dimensions.transactionPatternExposure)
    },
    overallConfidence: Math.round(overallConfidence * 100) / 100,
    scoringVersion: config.scoringVersion
  };
}

/**
 * Confidence calculation, see architecture.md §28.
 * Considers sample size, history depth, data completeness and parser reliability.
 */
export function computeConfidence(input: ScoreDimensionInput): Confidence {
  const sampleFactor = Math.min(1, input.transactionCount / 500);
  const historyFactor = Math.min(1, input.historyDays / 180);
  const completeness = input.transactionsRequested > 0 ? input.transactionsReceived / input.transactionsRequested : 0;
  const parserReliability = input.transactionsReceived > 0 ? 1 - input.parserFailures / input.transactionsReceived : 0;

  const confidence =
    0.4 * sampleFactor +
    0.2 * historyFactor +
    0.25 * clamp(completeness, 0, 1) +
    0.15 * clamp(parserReliability, 0, 1);

  return clamp(confidence, 0.05, 0.98);
}

function weighted(components: Array<[number, number]>): number {
  const totalWeight = components.reduce((sum, [, w]) => sum + w, 0);
  if (totalWeight === 0) return 0;
  return components.reduce((sum, [value, w]) => sum + value * (w / totalWeight), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type { Confidence, IntelligenceSignal, ScoreValue };
