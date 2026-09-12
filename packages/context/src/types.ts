import type { Confidence, Evidence, SignalCategory } from "@aegix/types";

export const CONTEXT_ENGINE_VERSION = "context-v1.0.0";

/**
 * Stable evidence identifier prefixes.
 *
 * Every fact the context profile exposes is addressable by one of these, so
 * that a later explanation layer can cite evidence by ID and have the
 * citation checked against what actually exists. The prefix says which kind
 * of fact it is; the suffix is the deterministic key within that kind.
 */
export const EVIDENCE_ID_PREFIX = {
  indicator: "ind",
  signal: "sig",
  dimension: "dim",
  coverage: "cov"
} as const;

export function indicatorId(signalType: string): string {
  return `${EVIDENCE_ID_PREFIX.indicator}:${signalType}`;
}

export function signalEvidenceId(signalType: string): string {
  return `${EVIDENCE_ID_PREFIX.signal}:${signalType}`;
}

export function dimensionId(key: string): string {
  return `${EVIDENCE_ID_PREFIX.dimension}:${key}`;
}

export function coverageId(key: string): string {
  return `${EVIDENCE_ID_PREFIX.coverage}:${key}`;
}

/**
 * Why the assembler declined to surface something as an indicator.
 *
 * Suppressions are reported, never silently dropped: a caller that cannot
 * see what was withheld cannot tell a quiet wallet from a quiet engine.
 */
export type SuppressionReason =
  | "ABSENCE_NOT_EVIDENCE"
  | "AGGREGATE_OF_LISTED_EVIDENCE"
  | "INSUFFICIENT_ACTIVITY";

export type ActivitySufficiency = "SUFFICIENT" | "INSUFFICIENT_ACTIVITY";

/**
 * AEGIX maintains no curated malicious-address dataset. The status is a
 * closed union with one member on purpose: there is no value this type can
 * take that would let a caller render "clean".
 */
export type RiskDatasetStatus = "NOT_AVAILABLE";
export type KnownRiskMatch = "NOT_CHECKED";

export interface KnownRiskCheck {
  dataset: RiskDatasetStatus;
  match: KnownRiskMatch;
  note: string;
}

/** A single contextual observation, traceable to the engine that produced it. */
export interface ContextIndicator {
  id: string;
  signalType: string;
  category: SignalCategory;
  severity: number;
  confidence: Confidence;
  title: string;
  description: string;
  sourceEngine: string;
  engineVersion: string;
  evidence: Evidence[];
  evidenceRefs: string[];
}

export interface SuppressedIndicator {
  id: string;
  signalType: string;
  category: SignalCategory;
  reason: SuppressionReason;
}

/**
 * The aggregate linkability view.
 *
 * It is deliberately not an indicator. The aggregate is computed from the
 * other categories' signals, so listing it beside them would report one fact
 * two or three times.
 */
export interface LinkabilityAssessment {
  converged: boolean;
  contributingCategories: SignalCategory[];
  severity: number | null;
  confidence: Confidence | null;
  note: string;
}

export interface ContextCoverage {
  transactionsParsed: number;
  historyStart: string | null;
  historyEnd: string | null;
  dataQualityScore: number | null;
  grade: string | null;
}

export interface ContextDimension {
  id: string;
  key: string;
  label: string;
  score: number;
}

export interface WalletContextProfile {
  wallet: string;
  analysisId: string;
  sufficiency: ActivitySufficiency;
  indicators: ContextIndicator[];
  suppressed: SuppressedIndicator[];
  linkability: LinkabilityAssessment;
  knownRisk: KnownRiskCheck;
  dimensions: ContextDimension[];
  coverage: ContextCoverage;
  limitations: string[];
  supportingEvidence?: ContextSupportingEvidence[];
  engineVersions: {
    context: string;
    pipeline: string | null;
    scoring: string | null;
  };
}

/** Persisted supporting observations are not additional indicators or independent corroboration. */
export interface ContextSupportingEvidence {
  id: string;
  category: "FUNDING_PROVENANCE" | "GRAPH_PATH" | "CORRELATION";
  title: string;
  description: string;
  confidence: Confidence;
  sourceEngine: string;
  engineVersion: string;
  evidence: Evidence[];
  observedAt: string;
  analysisId: string | null;
  limitations: string[];
}
