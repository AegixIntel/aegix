/**
 * TEMPORAL_CORRELATION evidence family, see docs/milestone-d5.md (D5-E).
 *
 * Detects timing relationships between two wallets' activity WITHOUT
 * inferring timezone, country or location (D5-E §6). Output is always
 * "activity timing pattern", never "owner lives in UTC+7".
 *
 * Signals (D5-E §5, implemented where data supports):
 *   - ACTIVE_HOUR_SIMILARITY / ACTIVE_DAY_SIMILARITY: distribution cosine
 *     over hour-of-day and day-of-week (normalized per wallet).
 *   - REPEATED_SHORT_WINDOW_ACTIVITY: A and B both active within a short
 *     window, repeated N times. One coincidence is weak; repetition required.
 *   - SEQUENTIAL_ACTIVITY_PATTERN: A active, then B active shortly after,
 *     repeated N times — directionality retained.
 *
 * Base-rate correction (D5-E §9-§10): expected random collisions
 *   E = (txA · txB · 2·window) / observationPeriod
 * Observed collisions are only meaningful above E. High-volume wallets do
 * not automatically correlate.
 *
 * Method: normalized distribution cosine — documented in JSDoc below.
 */

import { TEMPORAL_MAX_COLLISION_RATIO, TEMPORAL_MIN_REPEATED_MATCHES, TEMPORAL_SEQUENCE_WINDOW_SECONDS, TEMPORAL_WINDOWS_SECONDS } from "../config.js";
import type { EvidenceFamilyResult } from "../types.js";

export const TEMPORAL_ENGINE_VERSION = "temporal-v1.0.0";

export interface TemporalActivity {
  /** ISO timestamp of the activity. */
  timestamp: string;
  /** Transaction signature when available (for evidence output, D5-E §16). */
  signature?: string;
}

export interface TemporalInput {
  walletA: string;
  walletB: string;
  activityA: TemporalActivity[];
  activityB: TemporalActivity[];
  /** Observation period in seconds (defaults to span of both activity sets). */
  observationPeriodSeconds?: number;
  /** Low data quality / low semantic coverage caps confidence. */
  dataQualityA?: number; // 0-1
  dataQualityB?: number; // 0-1
  /** Transactions already attributed to other families (evidence de-dup, D5-E §18). */
  excludedSignaturesA?: Set<string>;
  excludedSignaturesB?: Set<string>;
}

interface WindowMatch {
  aTimestamp: string;
  bTimestamp: string;
  deltaSeconds: number;
  aSignature?: string;
  bSignature?: string;
}

function toMillis(ts: string): number {
  return new Date(ts).getTime();
}

/** Count how many B activities fall within [t, t+window] for each A activity.
 * Returns matched pairs (one A activity can match one B activity at most). */
function windowMatches(activityA: TemporalActivity[], activityB: TemporalActivity[], windowSeconds: number): WindowMatch[] {
  const sortedB = [...activityB].sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
  const usedB = new Set<number>();
  const matches: WindowMatch[] = [];
  for (const a of [...activityA].sort((x, y) => toMillis(x.timestamp) - toMillis(y.timestamp))) {
    const t = toMillis(a.timestamp);
    for (let i = 0; i < sortedB.length; i++) {
      if (usedB.has(i)) continue;
      const bt = toMillis(sortedB[i]!.timestamp);
      const delta = bt - t;
      if (delta >= 0 && delta <= windowSeconds * 1000) {
        usedB.add(i);
        matches.push({
          aTimestamp: a.timestamp,
          bTimestamp: sortedB[i]!.timestamp,
          deltaSeconds: Math.round(delta / 1000),
          aSignature: a.signature,
          bSignature: sortedB[i]!.signature
        });
        break;
      }
    }
  }
  return matches;
}

/** Normalized distribution over hour buckets (0-23) or weekday buckets (0-6). */
function distribution(activity: TemporalActivity[], mode: "hour" | "weekday"): Record<number, number> {
  const dist: Record<number, number> = {};
  for (const a of activity) {
    const d = new Date(toMillis(a.timestamp));
    const bucket = mode === "hour" ? d.getUTCHours() : d.getUTCDay();
    dist[bucket] = (dist[bucket] ?? 0) + 1;
  }
  const total = Object.values(dist).reduce((s, v) => s + v, 0);
  if (total <= 0) return {};
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(dist)) out[Number(k)] = v / total;
  return out;
}

/** Cosine similarity between two normalized distributions. */
function cosine(a: Record<number, number>, b: Record<number, number>): number {
  const keys = new Set([...Object.keys(a).map(Number), ...Object.keys(b).map(Number)]);
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

/**
 * Temporal correlation, see D5-E. Returns null when there is no meaningful
 * temporal evidence (single coincidence, or collisions explained by base
 * rate).
 */
export function evaluateTemporalCorrelation(input: TemporalInput): EvidenceFamilyResult | null {
  const { walletA, walletB, activityA, activityB } = input;
  if (activityA.length < TEMPORAL_MIN_REPEATED_MATCHES || activityB.length < TEMPORAL_MIN_REPEATED_MATCHES) return null;

  const allTimes = [...activityA, ...activityB].map((a) => toMillis(a.timestamp)).sort((a, b) => a - b);
  const spanMs = allTimes.length > 1 ? allTimes[allTimes.length - 1]! - allTimes[0]! : 0;
  const observationPeriod = input.observationPeriodSeconds ?? (spanMs > 0 ? spanMs / 1000 : 86400);
  if (observationPeriod <= 0) return null;

  const evidence: EvidenceFamilyResult["evidence"] = [];
  const limitations: string[] = [];
  let bestStrength = 0;
  let bestConfidence = 0;
  let repeatedMatches = 0;

  // 1. Short-window repeated activity (D5-E §7): try each configured window,
  // pick the window with the strongest base-rate-corrected signal.
  for (const window of TEMPORAL_WINDOWS_SECONDS) {
    const matches = windowMatches(activityA, activityB, window);
    if (matches.length < TEMPORAL_MIN_REPEATED_MATCHES) continue;

    // Base-rate correction (D5-E §9): expected random collisions.
    const expected = (activityA.length * activityB.length * 2 * window) / Math.max(1, observationPeriod);
    const observed = matches.length;
    if (observed <= expected * 1.2) continue; // at or below random expectation
    const excess = observed - expected;
    const collisionRatio = expected / Math.max(1, observed);
    if (collisionRatio > TEMPORAL_MAX_COLLISION_RATIO) continue; // too noisy

    const strength = Math.min(0.8, 0.25 + Math.min(1, excess / 5) * 0.4 + Math.min(1, matches.length / 8) * 0.15);
    const confidence = Math.min(0.85, 0.3 + matches.length * 0.06 + Math.min(0.2, 1 - collisionRatio) * 0.2);
    if (strength > bestStrength) {
      bestStrength = strength;
      bestConfidence = confidence;
      repeatedMatches = matches.length;
      evidence.length = 0;
      evidence.push(
        { key: "window_seconds", value: window, label: "Match window" },
        { key: "observed_matches", value: matches.length, label: "Observed matches" },
        { key: "expected_random", value: Math.round(expected * 100) / 100, label: "Expected random collisions" }
      );
      for (const m of matches.slice(0, 3)) {
        evidence.push({
          key: "match",
          value: `${m.aTimestamp} → ${m.bTimestamp} (Δ${m.deltaSeconds}s)`,
          label: `A:${m.aSignature?.slice(0, 8) ?? "?"} → B:${m.bSignature?.slice(0, 8) ?? "?"}`
        });
      }
      if (matches.length > 3) limitations.push(`${matches.length - 3} additional matched windows not shown`);
    }
  }

  // 2. Distribution similarity (D5-E §11): hour-of-day + day-of-week.
  const hourSim = cosine(distribution(activityA, "hour"), distribution(activityB, "hour"));
  const daySim = cosine(distribution(activityA, "weekday"), distribution(activityB, "weekday"));
  const distStrength = hourSim * 0.6 + daySim * 0.4;

  // 3. Directional sequence (D5-E §12): A then B within sequence window, repeated.
  const seqMatches = windowMatches(activityA, activityB, TEMPORAL_SEQUENCE_WINDOW_SECONDS);
  const directional = seqMatches.length >= TEMPORAL_MIN_REPEATED_MATCHES
    ? Math.min(0.6, 0.2 + seqMatches.length * 0.08)
    : 0;

  if (bestStrength === 0 && distStrength < 0.5 && directional === 0) return null;

  // Combine: short-window repeated activity dominates; distribution and
  // sequence add bounded support. Distribution-only similarity (same active
  // hours) is deliberately capped low — it has a high base rate and must
  // never produce meaningful correlation on its own (D5-E §14).
  const distContribution = bestStrength === 0 ? Math.min(0.3, distStrength * 0.3) : Math.min(0.15, distStrength * 0.1);
  const strength = Math.min(0.85, bestStrength + distContribution + directional * 0.1);

  // Confidence: repetition + base rate + sample + data quality (D5-E §13).
  let confidence = 0.25 + (bestStrength > 0 ? 0.25 : 0) + distStrength * 0.15 + directional * 0.15 + Math.min(0.15, repeatedMatches * 0.02);
  const sample = Math.min(activityA.length, activityB.length);
  if (sample < 10) confidence *= 0.6;
  const dq = Math.min(input.dataQualityA ?? 1, input.dataQualityB ?? 1);
  if (dq < 0.4) confidence *= 0.6;
  confidence = Math.min(0.85, Math.max(0.05, confidence));

  if (bestStrength === 0 && distStrength >= 0.5) {
    // Distribution-only similarity (same active hours) is weak (D5-E §14).
    limitations.push("Active-hour distribution similarity alone is weak evidence (high base rate)");
    evidence.push(
      { key: "hour_similarity", value: Math.round(hourSim * 100), label: "Hour-of-day distribution similarity" },
      { key: "day_similarity", value: Math.round(daySim * 100), label: "Day-of-week distribution similarity" }
    );
  } else {
    evidence.push(
      { key: "hour_similarity", value: Math.round(hourSim * 100), label: "Hour-of-day distribution similarity" },
      { key: "day_similarity", value: Math.round(daySim * 100), label: "Day-of-week distribution similarity" }
    );
  }
  if (directional > 0) {
    evidence.push({ key: "directional_sequence", value: seqMatches.length, label: `A→B within ${TEMPORAL_SEQUENCE_WINDOW_SECONDS}s repeats` });
  }

  limitations.push(
    "Activity timing patterns describe observable behavior; they never indicate where or when a person lives",
    "Temporal evidence is base-rate corrected; high-volume wallets naturally collide in time"
  );

  return {
    family: "TEMPORAL_CORRELATION",
    strength: Math.round(strength * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    summary: `Temporal correlation: ${repeatedMatches > 0 ? `${repeatedMatches} repeated short-window matches` : "similar activity timing distribution"}${directional > 0 ? `, ${seqMatches.length} directional A→B sequences` : ""}`,
    evidence: evidence.slice(0, 10),
    limitations: [...new Set(limitations)].slice(0, 6),
    engineVersion: TEMPORAL_ENGINE_VERSION
  };
}

export type { WindowMatch };
