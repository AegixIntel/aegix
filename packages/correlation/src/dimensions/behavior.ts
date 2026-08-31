/**
 * BEHAVIORAL_SIMILARITY evidence family, see docs/milestone-d5.md (D5-D).
 *
 * Deterministic, statistical similarity — no ML. Normalized per-wallet
 * distributions compared with cosine similarity; protocol sets with Jaccard.
 * High-volume wallets do not automatically appear more similar because each
 * distribution is normalized to a probability vector.
 *
 * Formulas:
 *   cosine(a, b) = Σ a_i·b_i / (√Σa_i² · √Σb_i²)
 *   jaccard(A, B) = |A∩B| / |A∪B|
 *
 * Sample adequacy (D5-D §28): <3 transactions → INSUFFICIENT (no family);
 * <10 → marginal (confidence capped); <30 → confidence capped.
 * Low semantic coverage (D5-D §29) caps confidence at 0.5.
 */

import {
  BEHAVIOR_SIMILARITY_FEATURES,
  LOW_SEMANTIC_COVERAGE_CAP,
  LOW_SEMANTIC_COVERAGE_THRESHOLD,
  MIN_SAMPLE_FOR_ANY_ASSESSMENT,
  MIN_SAMPLE_FOR_CONFIDENCE,
  MIN_SAMPLE_FOR_FULL_CONFIDENCE
} from "../config.js";
import type { EvidenceFamilyResult, SampleAdequacy } from "../types.js";
export const BEHAVIORAL_SIMILARITY_ENGINE_VERSION = "behavioral-similarity-v1.0.0";

export interface BehaviorInput {
  walletA: string;
  walletB: string;
  /** Persisted behavioral feature rows per wallet (behavioral_features). */
  featuresA: Array<{ feature_name: string; feature_value_json: unknown }>;
  featuresB: Array<{ feature_name: string; feature_value_json: unknown }>;
  /** Transaction count per wallet (sample adequacy). */
  transactionCountA: number;
  transactionCountB: number;
  /** Semantic coverage (0-1) per wallet from data_quality. */
  semanticCoverageA: number;
  semanticCoverageB: number;
}

type Distribution = Record<string, number>;

function toDistribution(features: Array<{ feature_name: string; feature_value_json: unknown }>, name: string): Distribution {
  const f = features.find((x) => x.feature_name === name);
  const raw = f?.feature_value_json;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Distribution;
  return {};
}

function normalize(dist: Distribution): Distribution {
  const total = Object.values(dist).reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return {};
  const out: Distribution = {};
  for (const [k, v] of Object.entries(dist)) {
    if (v > 0) out[k] = Math.max(0, v) / total;
  }
  return out;
}

function cosine(a: Distribution, b: Distribution): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const k of keys) {
    const va = a[k] ?? 0;
    const vb = b[k] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function jaccard(a: Distribution, b: Distribution): number {
  const keysA = new Set(Object.keys(a));
  const keysB = new Set(Object.keys(b));
  if (keysA.size === 0 && keysB.size === 0) return 0;
  const union = new Set([...keysA, ...keysB]);
  let inter = 0;
  for (const k of union) if (keysA.has(k) && keysB.has(k)) inter += 1;
  return inter / union.size;
}

export function sampleAdequacy(transactionCount: number): SampleAdequacy {
  if (transactionCount < MIN_SAMPLE_FOR_ANY_ASSESSMENT) return "INSUFFICIENT";
  if (transactionCount < MIN_SAMPLE_FOR_CONFIDENCE) return "MARGINAL";
  if (transactionCount < MIN_SAMPLE_FOR_FULL_CONFIDENCE) return "ADEQUATE";
  return "ADEQUATE";
}

/** Per-feature similarity with interpretable names. */
export function featureSimilarities(input: BehaviorInput): Array<{ feature: string; similarity: number }> {
  const na = new Map(input.featuresA.map((f) => [f.feature_name, f]));
  const nb = new Map(input.featuresB.map((f) => [f.feature_name, f]));

  const results: Array<{ feature: string; similarity: number }> = [];
  for (const name of BEHAVIOR_SIMILARITY_FEATURES) {
    const hasA = na.has(name);
    const hasB = nb.has(name);
    if (!hasA || !hasB) continue;
    const distA = normalize(toDistribution(input.featuresA, name));
    const distB = normalize(toDistribution(input.featuresB, name));
    if (name === "protocolDistribution") {
      results.push({ feature: name, similarity: jaccard(distA, distB) });
    } else {
      results.push({ feature: name, similarity: cosine(distA, distB) });
    }
  }
  return results;
}

export function evaluateBehavioralSimilarity(input: BehaviorInput): EvidenceFamilyResult | null {
  const adequacyA = sampleAdequacy(input.transactionCountA);
  const adequacyB = sampleAdequacy(input.transactionCountB);
  if (adequacyA === "INSUFFICIENT" || adequacyB === "INSUFFICIENT") return null;

  const similarities = featureSimilarities(input);
  if (similarities.length === 0) return null;

  const avg = similarities.reduce((s, x) => s + x.similarity, 0) / similarities.length;
  const strongest = [...similarities].sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const weakest = [...similarities].sort((a, b) => a.similarity - b.similarity).slice(0, 2);

  // Sample-size cap on confidence.
  const sample = Math.min(input.transactionCountA, input.transactionCountB);
  let confidence = 0.3 + avg * 0.4;
  if (sample < MIN_SAMPLE_FOR_CONFIDENCE) confidence *= 0.5;
  else if (sample < MIN_SAMPLE_FOR_FULL_CONFIDENCE) confidence *= 0.8;

  // Semantic coverage cap (D5-D §29).
  const coverage = Math.min(input.semanticCoverageA, input.semanticCoverageB);
  if (coverage < LOW_SEMANTIC_COVERAGE_THRESHOLD) {
    confidence = Math.min(confidence, LOW_SEMANTIC_COVERAGE_CAP);
  }
  confidence = Math.min(0.9, Math.max(0.05, confidence));

  const strength = Math.min(0.9, avg * 0.8 + 0.1);

  return {
    family: "BEHAVIORAL_SIMILARITY",
    strength,
    confidence,
    summary: `Behavioral similarity across ${similarities.length} feature(s): ${strongest.map((s) => `${s.feature} (${Math.round(s.similarity * 100)}%)`).join(", ")}`,
    evidence: strongest.map((s) => ({
      key: "similar_feature",
      value: Math.round(s.similarity * 100),
      label: `Strongest similarity: ${s.feature}`
    })),
    limitations: [
      ...weakest.map((s) => `Major difference: ${s.feature} (${Math.round(s.similarity * 100)}% similarity)`),
      `Sample: ${sample} transactions — confidence is limited by sample size`,
      coverage < LOW_SEMANTIC_COVERAGE_THRESHOLD ? "Semantic coverage is low, capping behavioral confidence" : ""
    ].filter(Boolean),
    engineVersion: BEHAVIORAL_SIMILARITY_ENGINE_VERSION
  };
}
