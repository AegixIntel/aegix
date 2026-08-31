/**
 * Cross-wallet correlation engine, see docs/milestone-d5.md (D5-B).
 *
 * Input: two wallets with their persisted normalized activity.
 * Output: correlation score (0-100), confidence (0-1), evidence families,
 * limitations — with safe language (never "SAME OWNER").
 *
 * Combination model:
 *   familyStrength_i → weighted by CORRELATION_FAMILY_WEIGHTS
 *   rawScore = Σ(weight_i · strength_i) / Σ(weight_i)          (0-1)
 *   correlationScore = round(rawScore · 100)
 *   confidence = sample-adjusted, coverage-adjusted, family-count-adjusted
 *
 * Evidence independence (D5-B §11): each family is computed over disjoint
 * observations — funding counts one direction, transfer the other;
 * counterparty overlap excludes A/B themselves; protocol similarity excludes
 * common protocols; asset flow excludes mints already counted as transfers.
 * A single transfer therefore never feeds two families.
 */

import { CORRELATION_ENGINE_VERSION, CORRELATION_FAMILY_WEIGHTS, FUNDING_MAX_HOPS, FUNDING_MAX_TRANSFERS, FUNDING_MAX_WALLETS, MIN_SAMPLE_FOR_ANY_ASSESSMENT, MIN_SAMPLE_FOR_CONFIDENCE, MIN_SAMPLE_FOR_FULL_CONFIDENCE } from "./config.js";
import { evaluateBehavioralSimilarity, type BehaviorInput } from "./dimensions/behavior.js";
import { evaluateFundingFamily, evaluateTransferFamily, type FundingTransferInput } from "./dimensions/funding.js";
import { evaluateCounterpartyOverlap, evaluateEntityOverlap, evaluateProtocolSimilarity, type OverlapInput } from "./dimensions/overlap.js";
import { canonicalPairId, classifyCorrelation, type CorrelationResult, type EvidenceFamilyResult } from "./types.js";
import type { TransferRow } from "@aegix/database";

export { CORRELATION_ENGINE_VERSION, CORRELATION_FAMILY_WEIGHTS, classifyCorrelation, canonicalPairId };
export type { CorrelationResult, CorrelationFamily, EvidenceFamilyResult, CorrelationClassification, EvidencePoint } from "./types.js";
export type { BehaviorInput } from "./dimensions/behavior.js";
export type { FundingTransferInput } from "./dimensions/funding.js";
export type { OverlapInput } from "./dimensions/overlap.js";
export { evaluateFundingFamily, evaluateTransferFamily } from "./dimensions/funding.js";
export { evaluateBehavioralSimilarity, featureSimilarities, sampleAdequacy } from "./dimensions/behavior.js";
export { evaluateCounterpartyOverlap, evaluateEntityOverlap, evaluateProtocolSimilarity, isHubAddress } from "./dimensions/overlap.js";

export interface CorrelationInput {
  walletA: string;
  walletB: string;
  /** Transfers involving wallet A. */
  transfersA: TransferRow[];
  /** Transfers involving wallet B. */
  transfersB: TransferRow[];
  /** Program interactions per wallet (for protocol similarity). */
  interactionsA?: Array<{ program_id: string; program_label: string | null }>;
  interactionsB?: Array<{ program_id: string; program_label: string | null }>;
  /** Verified entity addresses (registry). */
  knownEntityAddresses?: Set<string>;
  /** Behavioral features per wallet (persisted behavioral_features rows). */
  featuresA?: BehaviorInput["featuresA"];
  featuresB?: BehaviorInput["featuresB"];
  /** Transaction count per wallet (sample adequacy). */
  transactionCountA: number;
  transactionCountB: number;
  /** Semantic coverage 0-1 per wallet (data_quality). */
  semanticCoverageA?: number;
  semanticCoverageB?: number;
  /** Optional overrides (tests/ablation). */
  disabledFamilies?: Set<string>;
}

export function computeCorrelation(input: CorrelationInput): CorrelationResult {
  const {
    walletA,
    walletB,
    transfersA,
    transfersB,
    interactionsA = [],
    interactionsB = [],
    knownEntityAddresses,
    featuresA = [],
    featuresB = [],
    transactionCountA,
    transactionCountB,
    semanticCoverageA = 1,
    semanticCoverageB = 1,
    disabledFamilies = new Set()
  } = input;

  const fundingInput: FundingTransferInput = { walletA, walletB, transfersA, transfersB };
  const overlapInput: OverlapInput = {
    walletA,
    walletB,
    transfersA,
    transfersB,
    interactionsA,
    interactionsB,
    knownEntityAddresses
  };
  const behaviorInput: BehaviorInput = {
    walletA,
    walletB,
    featuresA,
    featuresB,
    transactionCountA,
    transactionCountB,
    semanticCoverageA,
    semanticCoverageB
  };

  // Compute each family (evidence-independent by construction).
  const families: EvidenceFamilyResult[] = [];
  if (!disabledFamilies.has("FUNDING")) {
    const f = evaluateFundingFamily(fundingInput);
    if (f) families.push(f);
  }
  if (!disabledFamilies.has("TRANSFER_RELATIONSHIP")) {
    const f = evaluateTransferFamily(fundingInput);
    if (f) families.push(f);
  }
  if (!disabledFamilies.has("COUNTERPARTY_OVERLAP")) {
    const f = evaluateCounterpartyOverlap(overlapInput);
    if (f) families.push(f);
  }
  if (!disabledFamilies.has("ENTITY_OVERLAP")) {
    const f = evaluateEntityOverlap(overlapInput);
    if (f) families.push(f);
  }
  if (!disabledFamilies.has("PROTOCOL_SEQUENCE_SIMILARITY")) {
    const f = evaluateProtocolSimilarity(overlapInput);
    if (f) families.push(f);
  }
  if (!disabledFamilies.has("BEHAVIORAL_SIMILARITY")) {
    const f = evaluateBehavioralSimilarity(behaviorInput);
    if (f) families.push(f);
  }

  // Weighted combination.
  const weights = new Map(CORRELATION_FAMILY_WEIGHTS.map((w) => [w.family, w]));
  let weightedSum = 0;
  let weightTotal = 0;
  for (const family of families) {
    const config = weights.get(family.family);
    if (!config || family.strength < config.minimumStrength) continue;
    weightedSum += config.weight * family.strength;
    weightTotal += config.weight;
  }
  const rawScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const correlationScore = Math.round(rawScore * 100);

  // Confidence: base on family count and strengths, then sample/coverage caps.
  const familyCount = families.length;
  let confidence = 0.25 + familyCount * 0.12 + rawScore * 0.3;
  const sample = Math.min(transactionCountA, transactionCountB);
  if (sample < MIN_SAMPLE_FOR_ANY_ASSESSMENT) confidence *= 0.4;
  else if (sample < MIN_SAMPLE_FOR_CONFIDENCE) confidence *= 0.6;
  else if (sample < MIN_SAMPLE_FOR_FULL_CONFIDENCE) confidence *= 0.85;
  const coverage = Math.min(semanticCoverageA, semanticCoverageB);
  if (coverage < 0.4) confidence *= 0.7;
  confidence = Math.min(0.98, Math.max(0.05, confidence));

  const limitations: string[] = [];
  if (sample < MIN_SAMPLE_FOR_ANY_ASSESSMENT) limitations.push(`Only ${sample} transaction(s) available — insufficient data for a confident assessment`);
  if (coverage < 0.4) limitations.push(`Semantic coverage is low (${Math.round(coverage * 100)}%) — behavioral and protocol evidence is limited`);
  for (const family of families) limitations.push(...family.limitations);
  if (familyCount === 0) limitations.push("No overlapping evidence families observed between these wallets");
  if (!input.disabledFamilies) limitations.push("Correlation describes observable evidence; it does not establish common ownership or real-world identity");

  return {
    correlationScore,
    confidence: Math.round(confidence * 100) / 100,
    classification: classifyCorrelation(correlationScore),
    evidenceFamilies: families,
    limitations: [...new Set(limitations)].slice(0, 8),
    engineVersion: CORRELATION_ENGINE_VERSION,
    pairId: canonicalPairId(walletA, walletB)
  };
}

/** Re-export the funding provenance v2 engine (D5-C) for pipeline wiring. */
export { traceFundingProvenance, FUNDING_PROVENANCE_ENGINE_VERSION, type FundingPath, type FundingProvenanceInput } from "./funding-provenance.js";
