/**
 * Correlation engine types re-exported from @aegix/types (shared across
 * packages so database repos can reference them without a circular
 * dependency on the correlation engine).
 */

export type {
  CorrelationFamily,
  CorrelationClassification,
  EvidencePoint,
  EvidenceFamilyResult,
  CorrelationResult,
  SampleAdequacy
} from "@aegix/types";
export { classifyCorrelation, canonicalPairId } from "@aegix/types";
