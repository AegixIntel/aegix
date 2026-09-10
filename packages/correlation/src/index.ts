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
import { evaluateTemporalCorrelation, TEMPORAL_ENGINE_VERSION, type TemporalInput } from "./dimensions/temporal.js";
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
export { evaluateTemporalCorrelation, TEMPORAL_ENGINE_VERSION, type TemporalInput } from "./dimensions/temporal.js";
export { FUNDING_FAMILY_ENGINE_VERSION, TRANSFER_FAMILY_ENGINE_VERSION } from "./dimensions/funding.js";
export { BEHAVIORAL_SIMILARITY_ENGINE_VERSION } from "./dimensions/behavior.js";
export {
  INFERRED_EDGE_ENGINE_VERSION,
  DEFAULT_INFERRED_EDGE_LIMITS,
  correlationToInferredEdge,
  correlationResultsToInferredEdges,
  type InferredEdgeLimits,
  type InferredEdgeOutcome,
  type InferredEdgeResult,
  type InferredEdgeRejection,
  type CorrelationRowLike,
  type InferredEdgeCandidate
} from "./inferred-edges.js";

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
  /** Timestamped activity per wallet (for temporal correlation, D5-E). */
  activityA?: TemporalInput["activityA"];
  activityB?: TemporalInput["activityB"];
  /** Optional overrides (tests/ablation). */
  disabledFamilies?: Set<string>;
  /**
   * D6-G: population commonality index (address -> observed frequency).
   * When present, overlap evidence discounts shared keys by their observed
   * population frequency (correlation penalty v2, §89). Absent → the D5
   * static common-activity penalties apply unchanged.
   */
  commonalityByAddress?: Map<string, number>;
  /** D6-G: minimum analyzed population for commonality to be trusted (§84). */
  commonalityMinPopulation?: number;
  /** D6-G/D6-I2: actual analyzed population size. Frequencies only influence
   *  the engine once populationSize >= commonalityMinPopulation (the
   *  data-quality gate lives in the caller: feature flag ON ≠ penalty active,
   *  D6-I2 §19). */
  populationSize?: number;
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
    knownEntityAddresses,
    commonalityByAddress: input.commonalityByAddress,
    commonalityMinPopulation: input.commonalityMinPopulation,
    populationSize: input.populationSize
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
  // Evidence independence (D5-B §11, D5-E §18): a transfer directly between A
  // and B is the observation the FUNDING and TRANSFER_RELATIONSHIP families
  // are built from. It also lands in both wallets' activity streams with one
  // shared signature and one shared block time, so temporal analysis would
  // pair it with itself and report a guaranteed zero-second "match". Feeding
  // the same transfer to a third family breaks the disjoint-observation
  // assumption of the weighted combination below, so those signatures are
  // withheld from the temporal family.
  const directTransferSignatures = new Set<string>();
  for (const transfer of [...transfersA, ...transfersB]) {
    const between =
      (transfer.from_address === walletA && transfer.to_address === walletB) ||
      (transfer.from_address === walletB && transfer.to_address === walletA);
    if (between && transfer.transaction_id) directTransferSignatures.add(transfer.transaction_id);
  }

  const temporalInput: TemporalInput = {
    walletA,
    walletB,
    activityA: input.activityA ?? [],
    activityB: input.activityB ?? [],
    dataQualityA: semanticCoverageA,
    dataQualityB: semanticCoverageB,
    excludedSignaturesA: directTransferSignatures,
    excludedSignaturesB: directTransferSignatures
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
  if (!disabledFamilies.has("TEMPORAL_CORRELATION")) {
    const f = evaluateTemporalCorrelation(temporalInput);
    if (f) families.push(f);
  }

  // Weighted combination.
  const weights = new Map(CORRELATION_FAMILY_WEIGHTS.map((w) => [w.family, w]));
  const admittedFamilies = families.filter((f) => {
    const config = weights.get(f.family);
    return config && f.strength >= config.minimumStrength;
  });
  let weightedSum = 0;
  let weightTotal = 0;
  for (const family of admittedFamilies) {
    const config = weights.get(family.family)!;
    weightedSum += config.weight * family.strength;
    weightTotal += config.weight;
  }
  let rawScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // Single-family cap (D5-K §69, §136): one non-direct evidence family alone
  // must never produce strong correlation. Shared behavior, shared entity,
  // shared counterparty or shared protocol are all common public patterns —
  // only direct flow (funding/transfers) may stand alone as strong evidence.
  const onlyFamily = admittedFamilies.length === 1 ? admittedFamilies[0]!.family : null;
  const isDirectFamily = onlyFamily === "FUNDING" || onlyFamily === "TRANSFER_RELATIONSHIP";
  if (onlyFamily && !isDirectFamily && rawScore > 0.45) {
    rawScore = 0.45;
  }
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
  if (onlyFamily && !isDirectFamily) limitations.push(`Only one evidence family (${onlyFamily}) is present — single-family correlation is capped because it could reflect common public behavior`);
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
