import type { Confidence, Timestamp } from "./common.js";

export interface AnalysisReport {
  id: string;
  analysisId: string;
  walletId: string;
  reportVersion: string;
  summaryJson: unknown;
  generatedText: string;
  createdAt: Timestamp;
}

/** Alert types for the Privacy Threat Monitor, see architecture.md §64. */
export type AlertType =
  | "NEW_LINKAGE"
  | "EXPOSURE_INCREASE"
  | "NEW_ENTITY_SIGNAL"
  | "NEW_CLUSTER_SIGNAL"
  | "BEHAVIOR_CHANGE"
  | "HIGH_RISK_RELATIONSHIP";

export interface ExposureAlert {
  id: string;
  walletId: string;
  alertType: AlertType;
  previousValue: number | null;
  newValue: number;
  summary: string;
  createdAt: Timestamp;
  acknowledgedAt: Timestamp | null;
}

export interface FeedbackEntry {
  id: string;
  analysisId: string;
  signalId: string | null;
  engineVersion: string;
  feedbackType: "INCORRECT_RELATIONSHIP" | "INCORRECT_ENTITY" | "IRRELEVANT_SIGNAL" | "SCORE_INACCURATE";
  comment: string | null;
  createdAt: Timestamp;
}

export type { Confidence };
