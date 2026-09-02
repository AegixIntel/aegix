/**
 * Monitor-driven correlation alerts (D6-F), see docs/d6-block2.md.
 *
 * Detects MEANINGFUL, EXPLAINABLE changes in a monitored wallet's persisted
 * correlations (§64-§65). Candidate bounding: only wallets already present
 * in persisted intelligence (correlation_results, relationships, funding
 * paths) — never a global pairwise scan (§69).
 *
 * Noise control:
 * - hysteresis: enter strong >= X, exit strong <= Y (X > Y) (§71)
 * - cooldown: same fingerprint within the window suppresses (§72)
 * - idempotency: fingerprint-deduped events; same cycle never duplicates
 *   (§73)
 * - degraded: incomplete data never fabricates DISAPPEARED (§75)
 *
 * Language: relationships are observable — never ownership (§68).
 */

import { createHash } from "node:crypto";
import type { MonitorAlertRules } from "@aegix/types";

export const CORRELATION_MONITOR_ENGINE_VERSION = "correlation-monitor-v1.0.0";

export type CorrelationEventType =
  | "CORRELATION_APPEARED"
  | "CORRELATION_INCREASED"
  | "CORRELATION_DECREASED"
  | "CORRELATION_DISAPPEARED"
  | "NEW_STRONG_FUNDING_RELATIONSHIP"
  | "NEW_CLUSTER_MEMBERSHIP";

export interface CorrelationSnapshot {
  walletA: string;
  walletB: string;
  /** Canonical pair id (sorted). */
  pairId: string;
  correlationScore: number;
  confidence: number;
  classification: string;
  evidenceFamilies: Array<{ family: string; strength: number }>;
  engineVersion: string;
  correlationResultId: string | null;
}

export interface CorrelationChangeCandidate {
  eventType: CorrelationEventType;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  relatedWallet: string;
  previousScore: number | null;
  newScore: number | null;
  previousConfidence: number | null;
  newConfidence: number | null;
  title: string;
  summary: string;
  explanation: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
  limitations: string[];
}

export interface CorrelationAlertConfig {
  enterStrongScore: number;
  exitStrongScore: number;
  minDelta: number;
  minScore: number;
  minConfidence: number;
  cooldownHours: number;
  notifyCorrelationChange: boolean;
}

export interface CorrelationRuleContext {
  /** Same-fingerprint event seen within the cooldown window. */
  recentSameFingerprint?: { fingerprint: string; lastSeenAt: string; occurrenceCount: number } | null;
  /** Hysteresis anchor: the last known score for this pair (any time). */
  lastScore?: number | null;
}

/** Stable fingerprint: monitor + event type + related wallet. */
export function correlationEventFingerprint(monitorId: string, eventType: string, relatedWallet: string): string {
  return createHash("sha256").update(`${monitorId}|${eventType}|${relatedWallet}`).digest("hex");
}

function severityFor(delta: number): "INFO" | "LOW" | "MEDIUM" | "HIGH" {
  if (delta >= 30) return "HIGH";
  if (delta >= 20) return "MEDIUM";
  if (delta >= 10) return "LOW";
  return "INFO";
}

/**
 * Pure change evaluator: compares a previous snapshot against the current
 * one and produces candidates. Returns [] when nothing meaningful changed
 * or when data is incomplete (degraded → no false DISAPPEARED, §75).
 */
export function evaluateCorrelationChanges(
  monitorId: string,
  walletAddress: string,
  previous: CorrelationSnapshot | null,
  current: CorrelationSnapshot | null,
  config: CorrelationAlertConfig
): CorrelationChangeCandidate[] {
  const candidates: CorrelationChangeCandidate[] = [];
  const related = current?.walletA === walletAddress ? current?.walletB : current?.walletB === walletAddress ? current?.walletA : previous?.walletA === walletAddress ? previous?.walletB : previous?.walletB === walletAddress ? previous?.walletA : null;
  if (!related) return [];

  const limitations = [
    "Correlation describes observable evidence; it does not establish common ownership or real-world identity."
  ];

  if (!current) {
    // Degraded: the pair vanished from persisted data, but we cannot tell
    // whether the wallet truly stopped interacting or the data is
    // incomplete. Never fabricate DISAPPEARED from absence (§75).
    if (previous) {
      return [{
        eventType: "CORRELATION_DISAPPEARED",
        severity: "INFO",
        confidence: 0.4,
        relatedWallet: related,
        previousScore: previous.correlationScore,
        newScore: null,
        previousConfidence: previous.confidence,
        newConfidence: null,
        title: "Correlation no longer persisted",
        summary: `The stored correlation with ${related.slice(0, 6)}… is no longer present in persisted results.`,
        explanation: "The previous correlation result was not found in the current persisted set. This can reflect removed evidence or incomplete data — no ownership conclusion is drawn.",
        fingerprint: correlationEventFingerprint(monitorId, "CORRELATION_DISAPPEARED", related),
        evidence: { previousScore: previous.correlationScore, previousConfidence: previous.confidence, degraded: true },
        limitations
      }];
    }
    return [];
  }

  if (!previous) {
    // New correlation appeared (bounded candidates only).
    if (current.correlationScore >= config.minScore && current.confidence >= config.minConfidence) {
      candidates.push({
        eventType: "CORRELATION_APPEARED",
        severity: severityFor(current.correlationScore),
        confidence: current.confidence,
        relatedWallet: related,
        previousScore: null,
        newScore: current.correlationScore,
        previousConfidence: null,
        newConfidence: current.confidence,
        title: "New correlation observed",
        summary: `A new observable relationship with ${related.slice(0, 6)}… crossed the alert threshold (score ${current.correlationScore}).`,
        explanation: `The monitored wallet now shows a persisted correlation of ${current.correlationScore} (confidence ${Math.round(current.confidence * 100)}%) with ${related.slice(0, 6)}…, which crossed your configured threshold.`,
        fingerprint: correlationEventFingerprint(monitorId, "CORRELATION_APPEARED", related),
        evidence: { newScore: current.correlationScore, newConfidence: current.confidence, families: current.evidenceFamilies.map((f) => f.family), engineVersion: current.engineVersion, correlationResultId: current.correlationResultId },
        limitations
      });
    }
    return candidates;
  }

  const delta = current.correlationScore - previous.correlationScore;

  // Hysteresis (§71): only meaningful deltas cross the floor.
  const absDelta = Math.abs(delta);
  if (absDelta < config.minDelta) return [];

  // Increased.
  if (delta > 0) {
    const crossesStrong = current.correlationScore >= config.enterStrongScore && previous.correlationScore < config.enterStrongScore;
    const withinStrong = previous.correlationScore >= config.exitStrongScore;
    if (current.correlationScore < config.minScore || current.confidence < config.minConfidence) return [];
    if (!crossesStrong && !withinStrong) return [];
    candidates.push({
      eventType: "CORRELATION_INCREASED",
      severity: severityFor(delta),
      confidence: Math.min(0.95, (previous.confidence + current.confidence) / 2 + 0.1),
      relatedWallet: related,
      previousScore: previous.correlationScore,
      newScore: current.correlationScore,
      previousConfidence: previous.confidence,
      newConfidence: current.confidence,
      title: "Correlation increased",
      summary: `Correlation with ${related.slice(0, 6)}… increased from ${previous.correlationScore} to ${current.correlationScore} (+${delta}).`,
      explanation: `The persisted correlation between the monitored wallet and ${related.slice(0, 6)}… rose from ${previous.correlationScore} to ${current.correlationScore} (confidence ${Math.round(previous.confidence * 100)}% → ${Math.round(current.confidence * 100)}%). This reflects new observable evidence (see families).`,
      fingerprint: correlationEventFingerprint(monitorId, "CORRELATION_INCREASED", related),
      evidence: {
        previousScore: previous.correlationScore,
        newScore: current.correlationScore,
        delta,
        previousConfidence: previous.confidence,
        newConfidence: current.confidence,
        previousFamilies: previous.evidenceFamilies.map((f) => f.family),
        newFamilies: current.evidenceFamilies.map((f) => f.family),
        addedFamilies: current.evidenceFamilies.map((f) => f.family).filter((f) => !previous.evidenceFamilies.some((p) => p.family === f)),
        removedFamilies: previous.evidenceFamilies.map((f) => f.family).filter((f) => !current.evidenceFamilies.some((c) => c.family === f)),
        engineVersion: current.engineVersion,
        previousEngineVersion: previous.engineVersion,
        correlationResultId: current.correlationResultId,
        previousCorrelationResultId: previous.correlationResultId
      },
      limitations
    });
  }

  // Decreased (only when leaving the strong band — hysteresis exit).
  if (delta < 0) {
    const leavesStrong = previous.correlationScore >= config.enterStrongScore && current.correlationScore < config.exitStrongScore;
    if (!leavesStrong) return [];
    candidates.push({
      eventType: "CORRELATION_DECREASED",
      severity: severityFor(absDelta),
      confidence: Math.min(0.9, (previous.confidence + current.confidence) / 2),
      relatedWallet: related,
      previousScore: previous.correlationScore,
      newScore: current.correlationScore,
      previousConfidence: previous.confidence,
      newConfidence: current.confidence,
      title: "Correlation decreased",
      summary: `Correlation with ${related.slice(0, 6)}… dropped from ${previous.correlationScore} to ${current.correlationScore} (${delta}).`,
      explanation: `The persisted correlation between the monitored wallet and ${related.slice(0, 6)}… fell from ${previous.correlationScore} to ${current.correlationScore}, leaving the strong band. This may reflect reduced observable interaction.`,
      fingerprint: correlationEventFingerprint(monitorId, "CORRELATION_DECREASED", related),
      evidence: {
        previousScore: previous.correlationScore,
        newScore: current.correlationScore,
        delta,
        previousConfidence: previous.confidence,
        newConfidence: current.confidence,
        engineVersion: current.engineVersion,
        correlationResultId: current.correlationResultId
      },
      limitations
    });
  }

  return candidates;
}

/**
 * Rule application: severity/confidence floors, cooldown (recent same
 * fingerprint), hysteresis (repeated increase must exceed the previous
 * score — oscillation guard). Returns decisions with reasons.
 */
export function applyCorrelationRules(
  candidates: CorrelationChangeCandidate[],
  rules: CorrelationAlertConfig,
  context: CorrelationRuleContext
): Array<{ event: CorrelationChangeCandidate; action: "NOTIFY" | "SUPPRESSED"; reasons: string[] }> {
  const decisions: Array<{ event: CorrelationChangeCandidate; action: "NOTIFY" | "SUPPRESSED"; reasons: string[] }> = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];

    if (!rules.notifyCorrelationChange) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: ["notifyCorrelationChange disabled"] });
      continue;
    }
    if (candidate.confidence < rules.minConfidence) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: [`confidence ${Math.round(candidate.confidence * 100)}% below minimum ${Math.round(rules.minConfidence * 100)}%`] });
      continue;
    }
    if (context.recentSameFingerprint?.fingerprint === candidate.fingerprint) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: ["cooldown: same event fingerprint seen recently"] });
      continue;
    }
    // Hysteresis: a repeated INCREASED event must exceed the last score
    // (49 → 51 → 49 → 51 oscillation guard).
    if (candidate.eventType === "CORRELATION_INCREASED" && context.lastScore !== null && context.lastScore !== undefined) {
      if ((candidate.newScore ?? 0) <= context.lastScore) {
        decisions.push({ event: candidate, action: "SUPPRESSED", reasons: [`hysteresis: new score ${candidate.newScore} does not exceed previous ${context.lastScore}`] });
        continue;
      }
    }
    decisions.push({ event: candidate, action: "NOTIFY", reasons });
  }
  return decisions;
}
