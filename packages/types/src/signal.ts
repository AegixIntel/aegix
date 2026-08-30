import type { Confidence } from "./common.js";

export type SignalCategory =
  | "IDENTITY_LINKABILITY"
  | "FUNDING"
  | "COUNTERPARTY"
  | "ENTITY"
  | "BEHAVIORAL"
  | "CLUSTER"
  | "TRANSACTION_PATTERN"
  | "PUBLIC_ATTRIBUTION";

/** Severity bands, see architecture.md §24. */
export type SeverityBand = "MINIMAL" | "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";

export interface Evidence {
  key: string;
  value: string | number | boolean;
  label: string;
}

export interface IntelligenceSignal {
  type: string;
  category: SignalCategory;
  severity: number; // 0 – 100
  confidence: Confidence;
  title: string;
  summary: string;
  evidence: Evidence[];
  engineVersion: string;
}

export function severityBand(severity: number): SeverityBand {
  if (severity < 20) return "MINIMAL";
  if (severity < 40) return "LOW";
  if (severity < 60) return "MODERATE";
  if (severity < 80) return "HIGH";
  return "VERY_HIGH";
}
