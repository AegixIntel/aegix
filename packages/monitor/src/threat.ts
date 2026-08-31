import { createHash } from "node:crypto";
import type {
  AlertDecision,
  EntityChange,
  ExposureDiff,
  MonitorAlertRules,
  RelationshipChange,
  ThreatCandidate,
  ThreatEventSeverity
} from "@aegix/types";

/**
 * Threat event engine, see docs/milestone-d4.md (D4-D).
 *
 * Difference is not threat: every candidate maps back to evidence in the diff.
 * Severity is derived from evidence and impact (relationship frequency, entity
 * type, path strength, score bands), never from a raw score delta alone.
 * Confidence is separate from severity and discounted when analyses are not
 * comparable (engine/scoring drift) or data quality dropped.
 */

export const SEVERITY_ORDER: ThreatEventSeverity[] = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function severityAtLeast(severity: ThreatEventSeverity, minimum: ThreatEventSeverity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(minimum);
}

/** Stable event fingerprint, see D4-D §40: monitor + type + subject. */
export function eventFingerprint(monitorId: string, eventType: string, subject: string): string {
  return createHash("sha256").update(`${monitorId}|${eventType}|${subject}`).digest("hex");
}

function severityBand(delta: number): ThreatEventSeverity {
  if (delta >= 50) return "CRITICAL";
  if (delta >= 35) return "HIGH";
  if (delta >= 20) return "MEDIUM";
  if (delta >= 10) return "LOW";
  return "INFO";
}

function formatCounterparty(cp: string): string {
  return cp.length > 12 ? `${cp.slice(0, 6)}…${cp.slice(-4)}` : cp;
}

/**
 * Maps an ExposureDiff to candidate threat events. Pure — no I/O.
 * The engine-version and data-quality policies live here (D4-C §32, D4-H §69).
 */
export function evaluateThreats(diff: ExposureDiff, walletAddress: string): ThreatCandidate[] {
  const candidates: ThreatCandidate[] = [];
  const monitorId = diff.monitorId;
  const comparable = diff.comparability.comparable;
  const versionNote = comparable ? null : `Comparison ${diff.comparability.reason ?? "version drift"}; score-based changes not attributed to wallet activity.`;

  // Data-quality degradation is reported as its own event and suppresses
  // exposure-increase events derived from a degraded comparison (D4-C §29).
  if (diff.dataQualityChange.degraded) {
    const prevCoverage = diff.dataQualityChange.previous?.semanticCoverage ?? 0;
    const prevScore = diff.dataQualityChange.previous?.score ?? 0;
    const drop = Math.max(prevCoverage - diff.dataQualityChange.current.semanticCoverage, prevScore - diff.dataQualityChange.current.score);
    if (diff.dataQualityChange.material) {
      candidates.push({
        eventType: "DATA_QUALITY_DEGRADED",
        severity: drop >= 40 ? "HIGH" : "MEDIUM",
        confidence: Math.min(0.9, 0.5 + drop / 200),
        subject: "analysis-quality",
        title: "Analysis data quality degraded",
        summary: `Semantic coverage dropped from ${Math.round(prevCoverage)}% to ${Math.round(diff.dataQualityChange.current.semanticCoverage)}%. This comparison is less reliable than the previous one.`,
        explanation: `The latest analysis understood less of the wallet's activity (coverage ${Math.round(prevCoverage)}% → ${Math.round(diff.dataQualityChange.current.semanticCoverage)}%). Exposure changes from this comparison are not reported as real changes.`,
        fingerprint: eventFingerprint(monitorId, "DATA_QUALITY_DEGRADED", "analysis-quality"),
        evidence: {
          previousDataQualityScore: prevScore,
          currentDataQualityScore: diff.dataQualityChange.current.score,
          previousSemanticCoverage: prevCoverage,
          currentSemanticCoverage: diff.dataQualityChange.current.semanticCoverage,
          analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
        }
      });
    }
    // Suppress everything else: the comparison is not trustworthy.
    return candidates;
  }

  // Overall exposure increase (suppressed entirely on version drift).
  if (comparable && diff.overallChange.direction === "INCREASED" && diff.overallChange.delta >= 10) {
    const severity = severityBand(diff.overallChange.delta);
    candidates.push({
      eventType: "PRIVACY_EXPOSURE_INCREASED",
      severity,
      confidence: diff.confidence,
      subject: "OVERALL",
      title: "Privacy exposure increased",
      summary: `Overall exposure increased by ${diff.overallChange.delta} points (${diff.overallChange.previous} → ${diff.overallChange.current}).`,
      explanation: `The monitored wallet's overall privacy exposure rose from ${diff.overallChange.previous} to ${diff.overallChange.current} (+${diff.overallChange.delta}). Confidence: ${Math.round(diff.confidence * 100)}%.`,
      fingerprint: eventFingerprint(monitorId, "PRIVACY_EXPOSURE_INCREASED", "OVERALL"),
      evidence: {
        previousScore: diff.overallChange.previous,
        currentScore: diff.overallChange.current,
        delta: diff.overallChange.delta,
        analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
      }
    });
  }

  // Identity linkability increase (suppressed on version drift).
  const identityDim = diff.dimensionChanges.find((d) => d.key === "identityLinkability");
  if (comparable && identityDim && identityDim.change.direction === "INCREASED" && identityDim.change.delta >= 15) {
    candidates.push({
      eventType: "IDENTITY_LINKABILITY_INCREASED",
      severity: severityBand(identityDim.change.delta),
      confidence: diff.confidence,
      subject: "identity-linkability",
      title: "Identity linkability increased",
      summary: `Identity Linkability increased by ${identityDim.change.delta} points (${identityDim.change.previous} → ${identityDim.change.current}).`,
      explanation: `Observable signals that may increase wallet linkability rose from ${identityDim.change.previous} to ${identityDim.change.current} (+${identityDim.change.delta}).`,
      fingerprint: eventFingerprint(monitorId, "IDENTITY_LINKABILITY_INCREASED", "identity-linkability"),
      evidence: {
        previousScore: identityDim.change.previous,
        currentScore: identityDim.change.current,
        delta: identityDim.change.delta,
        analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
      }
    });
  }

  // New entity exposure (allowed on version drift, discounted confidence).
  for (const ec of diff.entityChanges.filter((c) => c.change === "NEW_ENTITY_EXPOSURE")) {
    const isExchange = ec.entityType === "CENTRALIZED_EXCHANGE";
    const currentConfidence = ec.current?.confidence ?? 0;
    const currentCount = ec.current?.count ?? 0;
    candidates.push({
      eventType: "NEW_ENTITY_EXPOSURE",
      severity: isExchange ? "HIGH" : "MEDIUM",
      confidence: comparable ? Math.min(0.95, 0.6 + currentConfidence * 0.3) : 0.6 * 0.7,
      subject: ec.entityName,
      title: `New entity exposure: ${ec.entityName}`,
      summary: `New interaction detected with ${ec.entityName}.`,
      explanation: `The wallet now shows observable interaction with ${ec.entityName}, which may increase linkability. Confidence: ${Math.round((comparable ? Math.min(0.95, 0.6 + currentConfidence * 0.3) : 0.6 * 0.7) * 100)}%.${versionNote ? ` ${versionNote}` : ""}`,
      fingerprint: eventFingerprint(monitorId, "NEW_ENTITY_EXPOSURE", ec.entityName),
      evidence: {
        entityName: ec.entityName,
        entityType: ec.entityType,
        interactionCount: currentCount,
        confidence: currentConfidence,
        analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
      }
    });
  }

  // New repeated funder / dominant funding relationship.
  for (const rc of diff.relationshipChanges) {
    const subject = formatCounterparty(rc.counterparty);
    if (rc.change === "NEW_REPEATED_COUNTERPARTY" || rc.change === "REPEATED_FUNDING_RELATIONSHIP_CREATED") {
      const count = rc.current?.transactionCount ?? 0;
      const severity: ThreatEventSeverity = count >= 5 ? "HIGH" : "MEDIUM";
      candidates.push({
        eventType: "NEW_REPEATED_FUNDER",
        severity,
        confidence: Math.min(0.95, 0.55 + count * 0.05),
        subject: `funder:${rc.counterparty}`,
        title: "New repeated funding relationship",
        summary: `The wallet received funds from the same address ${count} times since the previous analysis.`,
        explanation: `A new repeated funding relationship was observed. The monitored wallet received funds from the same address ${count} times since the previous analysis. Confidence: ${Math.round(Math.min(0.95, 0.55 + count * 0.05) * 100)}%.`,
        fingerprint: eventFingerprint(monitorId, "NEW_REPEATED_FUNDER", `funder:${rc.counterparty}`),
        evidence: {
          counterparty: rc.counterparty,
          transactionCount: count,
          change: rc.change,
          analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
        }
      });
    } else if (rc.change === "FUNDING_SOURCE_BECAME_DOMINANT") {
      candidates.push({
        eventType: "NEW_STRONG_COUNTERPARTY_LINK",
        severity: "MEDIUM",
        confidence: 0.7,
        subject: `dominant:${rc.counterparty}`,
        title: "Funding source became dominant",
        summary: `A single funding source now dominates the wallet's incoming activity.`,
        explanation: `One address now accounts for the majority of the wallet's funding, strengthening an observable relationship. Confidence: 70%.`,
        fingerprint: eventFingerprint(monitorId, "NEW_STRONG_COUNTERPARTY_LINK", `dominant:${rc.counterparty}`),
        evidence: {
          counterparty: rc.counterparty,
          concentration: rc.current?.concentration ?? 0,
          analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
        }
      });
    }
  }

  // New / strengthened attack paths (allowed on version drift, discounted).
  for (const apc of diff.attackPathChanges) {
    const subject = `path:${apc.pathId}`;
    if (apc.change === "NEW_EXPOSURE_PATH") {
      const severity: ThreatEventSeverity = apc.current.pathScore >= 0.5 ? "HIGH" : "MEDIUM";
      candidates.push({
        eventType: "NEW_ATTACK_PATH",
        severity,
        confidence: comparable ? Math.min(0.9, 0.5 + apc.current.pathScore) : 0.5,
        subject,
        title: "New exposure path detected",
        summary: "A new observable path linking the wallet to an entity was detected.",
        explanation: `Attack My Wallet found a new exposure path with strength ${apc.current.pathScore.toFixed(2)} and confidence ${Math.round(apc.current.confidence * 100)}%.`,
        fingerprint: eventFingerprint(monitorId, "NEW_ATTACK_PATH", subject),
        evidence: {
          pathId: apc.pathId,
          pathScore: apc.current.pathScore,
          pathConfidence: apc.current.confidence,
          analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
        }
      });
    } else if (apc.change === "STRONGER_EXPOSURE_PATH") {
      candidates.push({
        eventType: "ATTACK_PATH_STRENGTHENED",
        severity: "MEDIUM",
        confidence: comparable ? 0.7 : 0.5,
        subject,
        title: "Exposure path strengthened",
        summary: "An existing exposure path became stronger.",
        explanation: `An existing exposure path increased in strength from ${apc.previous?.pathScore.toFixed(2)} to ${apc.current.pathScore.toFixed(2)}.`,
        fingerprint: eventFingerprint(monitorId, "ATTACK_PATH_STRENGTHENED", subject),
        evidence: {
          pathId: apc.pathId,
          previousPathScore: apc.previous?.pathScore ?? 0,
          currentPathScore: apc.current.pathScore,
          analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
        }
      });
    }
  }

  // Behavioral fingerprint strengthening (only when comparable).
  if (comparable) {
    for (const bc of diff.behaviorChanges) {
      candidates.push({
        eventType: "BEHAVIORAL_FINGERPRINT_STRENGTHENED",
        severity: "LOW",
        confidence: 0.6,
        subject: `behavior:${bc.feature}`,
        title: "Behavioral fingerprint strengthened",
        summary: `The wallet's observable activity pattern became more distinctive (${bc.feature}).`,
        explanation: `The wallet's ${bc.feature.replace(/([A-Z])/g, " $1").toLowerCase()} signal became more pronounced, which may increase linkability.`,
        fingerprint: eventFingerprint(monitorId, "BEHAVIORAL_FINGERPRINT_STRENGTHENED", `behavior:${bc.feature}`),
        evidence: {
          feature: bc.feature,
          previous: bc.previous,
          current: bc.current,
          analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
        }
      });
    }
  }

  // New cluster link (from relationship concentration increases).
  for (const rc of diff.relationshipChanges) {
    if (rc.change === "COUNTERPARTY_CONCENTRATION_INCREASED") {
      candidates.push({
        eventType: "NEW_CLUSTER_LINK",
        severity: "LOW",
        confidence: 0.55,
        subject: `cluster:${rc.counterparty}`,
        title: "Counterparty concentration increased",
        summary: "Activity is increasingly concentrated on a single counterparty.",
        explanation: `Counterparty concentration rose to ${Math.round((rc.current?.concentration ?? 0) * 100)}%, a potential cluster link signal.`,
        fingerprint: eventFingerprint(monitorId, "NEW_CLUSTER_LINK", `cluster:${rc.counterparty}`),
        evidence: {
          counterparty: rc.counterparty,
          concentration: rc.current?.concentration ?? 0,
          analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
        }
      });
    }
  }

  // Event merging, see D4-H §66: cap 3 events per type per diff; the surplus
  // collapses into one consolidated "multiple" event.
  return mergeCandidates(candidates, monitorId, diff);
}

/** Groups same-type candidates beyond the cap into one consolidated event. */
function mergeCandidates(candidates: ThreatCandidate[], monitorId: string, diff: ExposureDiff): ThreatCandidate[] {
  const MAX_PER_TYPE = 3;
  const byType = new Map<string, ThreatCandidate[]>();
  for (const c of candidates) {
    const list = byType.get(c.eventType) ?? [];
    list.push(c);
    byType.set(c.eventType, list);
  }
  const merged: ThreatCandidate[] = [];
  for (const [type, list] of byType) {
    if (list.length <= MAX_PER_TYPE) {
      merged.push(...list);
      continue;
    }
    const kept = list.slice(0, MAX_PER_TYPE - 1);
    const rest = list.slice(MAX_PER_TYPE - 1);
    const subjects = rest.map((c) => c.subject).join(", ");
    kept.push({
      eventType: type as ThreatCandidate["eventType"],
      severity: rest.some((c) => c.severity === "HIGH" || c.severity === "CRITICAL") ? "HIGH" : "MEDIUM",
      confidence: Math.max(...rest.map((c) => c.confidence)),
      subject: "multiple",
      title: `${list[0]?.title ?? "Multiple findings"} (${rest.length} more)`,
      summary: `${rest.length} additional related findings were grouped into this event.`,
      explanation: `${rest.length} related findings (${subjects}) were consolidated to reduce alert noise.`,
      fingerprint: eventFingerprint(monitorId, type, "multiple"),
      evidence: {
        consolidated: true,
        groupedSubjects: rest.map((c) => c.subject),
        analysisIds: [diff.previousAnalysisId, diff.currentAnalysisId]
      }
    });
    merged.push(...kept);
  }
  return merged;
}

/**
 * Alert rule engine, see docs/milestone-d4.md (D4-E).
 * Pure decision function: thresholds, confidence floor, per-type toggles,
 * cooldown and hysteresis. Reasons are returned so they can be persisted.
 */
export function applyRules(
  candidates: ThreatCandidate[],
  rules: MonitorAlertRules,
  context: { recentSameFingerprint?: { fingerprint: string; delta: number } | null }
): AlertDecision[] {
  const decisions: AlertDecision[] = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];

    // Per-type toggles.
    if (candidate.eventType === "NEW_ENTITY_EXPOSURE" && !rules.notifyNewEntity) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: ["notifyNewEntity disabled"] });
      continue;
    }
    if (candidate.eventType === "NEW_ATTACK_PATH" && !rules.notifyNewAttackPath) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: ["notifyNewAttackPath disabled"] });
      continue;
    }
    if (candidate.eventType === "BEHAVIORAL_FINGERPRINT_STRENGTHENED" && !rules.notifyBehaviorChange) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: ["notifyBehaviorChange disabled"] });
      continue;
    }
    if (candidate.eventType === "DATA_QUALITY_DEGRADED" && !rules.notifyDataQualityDegraded) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: ["notifyDataQualityDegraded disabled"] });
      continue;
    }

    // Severity + confidence floors.
    if (!severityAtLeast(candidate.severity, rules.minimumSeverity)) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: [`severity ${candidate.severity} below minimum ${rules.minimumSeverity}`] });
      continue;
    }
    if (candidate.confidence < rules.minimumConfidence) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: [`confidence ${Math.round(candidate.confidence * 100)}% below minimum ${Math.round(rules.minimumConfidence * 100)}%`] });
      continue;
    }

    // Score delta threshold for score-based events.
    if (candidate.eventType === "PRIVACY_EXPOSURE_INCREASED" || candidate.eventType === "IDENTITY_LINKABILITY_INCREASED") {
      const delta = (candidate.evidence.delta as number | undefined) ?? 0;
      if (delta < rules.overallScoreDeltaThreshold) {
        decisions.push({ event: candidate, action: "SUPPRESSED", reasons: [`score delta ${delta} below threshold ${rules.overallScoreDeltaThreshold}`] });
        continue;
      }
    }

    // Cooldown: same fingerprint seen recently → suppress (D4-H §64).
    if (context.recentSameFingerprint?.fingerprint === candidate.fingerprint) {
      decisions.push({ event: candidate, action: "SUPPRESSED", reasons: ["cooldown: same event fingerprint seen recently"] });
      continue;
    }

    // Hysteresis (D4-H §65): for score-increase events, a repeated increase
    // must exceed the previous increase, else it is oscillation.
    if (candidate.eventType === "PRIVACY_EXPOSURE_INCREASED" && context.recentSameFingerprint) {
      const delta = (candidate.evidence.delta as number | undefined) ?? 0;
      if (delta <= context.recentSameFingerprint.delta) {
        decisions.push({ event: candidate, action: "SUPPRESSED", reasons: [`hysteresis: delta ${delta} does not exceed previous ${context.recentSameFingerprint.delta}`] });
        continue;
      }
    }

    decisions.push({ event: candidate, action: "NOTIFY", reasons });
  }
  return decisions;
}

export type { EntityChange, RelationshipChange };
