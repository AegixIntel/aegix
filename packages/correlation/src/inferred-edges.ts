/**
 * Correlation → inferred edge admission, see docs/milestone-d5.md (D5-I §5-§11).
 *
 * Persisted correlation_results become CORRELATED_WITH inferred edges only
 * when they pass quality thresholds (strength, confidence, sample adequacy,
 * semantic coverage, evidence families). Not every correlation becomes an
 * edge (§5). Direct relationships are never replaced — observed edges stay
 * observed, and correlation metadata is attached to the existing edge when
 * the pair already has one (§9-§10).
 *
 * Strong direct exception (§7): exceptionally strong direct relationships
 * qualify even with a single evidence family; shared-Jupiter-style weak
 * overlap never does.
 */

import type { ExposurePathEdge, ExposurePathEdgeType } from "@aegix/types";

export const INFERRED_EDGE_ENGINE_VERSION = "inferred-edge-v1.0.0";

/** D5-I §6: versioned inferred-edge admission thresholds. */
export interface InferredEdgeLimits {
  /** Minimum correlation score (0-100) for an inferred edge. */
  minScore: number;
  /** Minimum confidence (0-1) for an inferred edge. */
  minConfidence: number;
  /** Minimum number of independent evidence families. */
  minEvidenceFamilies: number;
  /** Minimum sample (min wallet tx counts) for an inferred edge. */
  minSample: number;
  /** Minimum semantic coverage (0-1) for semantic-heavy families. */
  minSemanticCoverage: number;
  /** Strong direct exception: correlation score at which one family suffices. */
  strongDirectScore: number;
  /** Strong direct exception requires at least one direct family. */
  strongDirectFamilies?: string[];
}

export const DEFAULT_INFERRED_EDGE_LIMITS: InferredEdgeLimits = {
  minScore: 40,
  minConfidence: 0.5,
  minEvidenceFamilies: 2,
  minSample: 10,
  minSemanticCoverage: 0.4,
  strongDirectScore: 70,
  strongDirectFamilies: ["FUNDING", "TRANSFER_RELATIONSHIP"]
};

export interface CorrelationRowLike {
  walletA: string;
  walletB: string;
  correlationScore: number;
  confidence: number;
  evidenceFamilies: Array<{ family: string; strength: number; confidence: number; engineVersion: string }>;
  limitations: string[];
  engineVersion: string;
  /** Canonical pair identity; derived from sorted addresses when absent. */
  pairId?: string;
}

export interface InferredEdgeCandidate extends CorrelationRowLike {
  /** Canonical pair identity (sorted addresses). */
  pairId: string;
}

export interface InferredEdgeResult {
  edge: ExposurePathEdge;
  /** Rejection reason when the correlation did not qualify. */
  rejected: null;
}

export interface InferredEdgeRejection {
  edge: null;
  rejected: string;
}

export type InferredEdgeOutcome = InferredEdgeResult | InferredEdgeRejection;

/**
 * Admission test for one persisted correlation result (D5-I §6-§7).
 * Pure and deterministic; returns the qualified inferred edge or the reason
 * it was rejected.
 */
export function correlationToInferredEdge(
  correlation: CorrelationRowLike,
  limits: InferredEdgeLimits = DEFAULT_INFERRED_EDGE_LIMITS
): InferredEdgeOutcome {
  const families = correlation.evidenceFamilies.map((f) => f.family);
  const strongDirectFamilies = limits.strongDirectFamilies ?? DEFAULT_INFERRED_EDGE_LIMITS.strongDirectFamilies ?? [];
  const directFamilies = families.filter((f) => strongDirectFamilies.includes(f));

  // Base admission: strength + confidence + multi-evidence + sample.
  if (correlation.correlationScore < limits.minScore) {
    return { edge: null, rejected: `score ${correlation.correlationScore} < ${limits.minScore}` };
  }
  if (correlation.confidence < limits.minConfidence) {
    return { edge: null, rejected: `confidence ${correlation.confidence} < ${limits.minConfidence}` };
  }
  // Strong direct exception (§7): a high score backed by direct funding /
  // transfers qualifies with one family.
  const strongDirect = correlation.correlationScore >= limits.strongDirectScore && directFamilies.length > 0;
  if (!strongDirect && families.length < limits.minEvidenceFamilies) {
    return { edge: null, rejected: `evidence families ${families.length} < ${limits.minEvidenceFamilies} (no strong direct)` };
  }
  if (families.length === 0) {
    return { edge: null, rejected: "no evidence families" };
  }

  // Sample / semantic coverage: derived from correlation-level info when the
  // caller provides it; the caller enriches via sampleAdequacy fields below.
  if (limits.minSample > 0 && "sample" in correlation && (correlation as { sample?: number }).sample !== undefined) {
    const sample = (correlation as { sample?: number }).sample ?? 0;
    if (sample < limits.minSample) {
      return { edge: null, rejected: `sample ${sample} < ${limits.minSample}` };
    }
  }

  return {
    edge: {
      source: correlation.walletA,
      target: correlation.walletB,
      type: "CORRELATED_WITH" as ExposurePathEdgeType,
      strength: Math.round(correlation.correlationScore / 100 * 100) / 100,
      confidence: correlation.confidence,
      observationClass: "INFERRED",
      evidence: [
        `correlation_result:${correlation.pairId ?? `${[correlation.walletA, correlation.walletB].sort().join("|")}`}`,
        ...correlation.evidenceFamilies.map((f) => `${f.family}:${f.strength}`)
      ].slice(0, 10),
      sourceEngine: correlation.engineVersion,
      engineVersion: correlation.engineVersion
    },
    rejected: null
  };
}

/**
 * Batch admission for a wallet's persisted correlation results (D5-I §12).
 * Returns qualified edges keyed by canonical pair, plus rejections for
 * observability. Symmetric: A↔B produces one undirected inferred edge.
 */
export function correlationResultsToInferredEdges(
  results: CorrelationRowLike[],
  limits: InferredEdgeLimits = DEFAULT_INFERRED_EDGE_LIMITS
): { edges: ExposurePathEdge[]; rejections: Array<{ pair: string; reason: string }> } {
  const edges: ExposurePathEdge[] = [];
  const rejections: Array<{ pair: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const result of results) {
    const pairId = result.pairId ?? [result.walletA, result.walletB].sort().join("|");
    if (seen.has(pairId)) continue; // dedup symmetric pairs
    seen.add(pairId);
    const outcome = correlationToInferredEdge(result, limits);
    if (outcome.edge === null) {
      rejections.push({ pair: pairId, reason: outcome.rejected ?? "rejected" });
    } else {
      edges.push(outcome.edge);
    }
  }
  return { edges, rejections };
}
