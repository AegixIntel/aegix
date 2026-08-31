/**
 * Cross-wallet correlation types, see docs/milestone-d5.md (D5-B).
 *
 * Core principle: CORRELATION ≠ OWNERSHIP ≠ IDENTITY.
 * A correlation result describes observable evidence that two wallets may
 * be related; it never claims common ownership or real-world identity.
 */

import type { Confidence } from "./common.js";

/** Independent evidence families. */
export type CorrelationFamily =
  | "FUNDING"
  | "TRANSFER_RELATIONSHIP"
  | "COUNTERPARTY_OVERLAP"
  | "ENTITY_OVERLAP"
  | "BEHAVIORAL_SIMILARITY"
  | "TEMPORAL_CORRELATION"
  | "PROTOCOL_SEQUENCE_SIMILARITY"
  | "ASSET_FLOW_CORRELATION";

/** Safe language classification — never "SAME OWNER". */
export type CorrelationClassification =
  | "VERY_LOW_CORRELATION"
  | "LOW_CORRELATION"
  | "MODERATE_CORRELATION"
  | "HIGH_CORRELATION"
  | "VERY_HIGH_CORRELATION";

export interface EvidencePoint {
  key: string;
  value: string | number | boolean;
  label: string;
}

export interface EvidenceFamilyResult {
  family: CorrelationFamily;
  /** 0 – 1 observed pattern strength for this family. */
  strength: number;
  /** 0 – 1 confidence in this family's assessment. */
  confidence: Confidence;
  /** Human-readable summary of what was observed. */
  summary: string;
  /** Concrete observations backing the family (signatures, timestamps, addresses). */
  evidence: EvidencePoint[];
  /** Reasons this family might be misleading. */
  limitations: string[];
}

export interface CorrelationResult {
  /** Bounded correlation strength 0 – 100 (observed pattern intensity). */
  correlationScore: number;
  /** Bounded confidence 0 – 1 (how much the available evidence supports the score). */
  confidence: Confidence;
  classification: CorrelationClassification;
  evidenceFamilies: EvidenceFamilyResult[];
  limitations: string[];
  /** Engine + weight config version. */
  engineVersion: string;
  /** Deterministic canonical pair identity (sorted addresses). */
  pairId: string;
}

/** Sample-size adequacy guard, see docs/milestone-d5.md (D5-D §28). */
export type SampleAdequacy = "INSUFFICIENT" | "MARGINAL" | "ADEQUATE";

export function classifyCorrelation(score: number): CorrelationClassification {
  if (score < 15) return "VERY_LOW_CORRELATION";
  if (score < 35) return "LOW_CORRELATION";
  if (score < 60) return "MODERATE_CORRELATION";
  if (score < 80) return "HIGH_CORRELATION";
  return "VERY_HIGH_CORRELATION";
}

/** Canonical pair id: sorted addresses joined by "|" (A,B) = (B,A). */
export function canonicalPairId(a: string, b: string): string {
  return [a, b].sort().join("|");
}
