import type { Confidence, ScoreValue } from "./common.js";

/** Privacy exposure score dimensions, see architecture.md §26. */
export interface ExposureScore {
  analysisId: string;
  walletId: string;
  overallScore: ScoreValue;
  identityLinkability: ScoreValue;
  fundingExposure: ScoreValue;
  walletClusterExposure: ScoreValue;
  behavioralFingerprint: ScoreValue;
  counterpartyExposure: ScoreValue;
  entityExposure: ScoreValue;
  transactionPatternExposure: ScoreValue;
  overallConfidence: Confidence;
  scoringVersion: string;
  createdAt: string;
}

/** Versioned component weight configuration, see architecture.md §123. */
export interface ScoringConfig {
  scoringVersion: string;
  fundingExposure: Record<string, number>;
  identityLinkability: Record<string, number>;
  walletClusterExposure: Record<string, number>;
  behavioralFingerprint: Record<string, number>;
  counterpartyExposure: Record<string, number>;
  entityExposure: Record<string, number>;
  transactionPatternExposure: Record<string, number>;
  dimensionWeights: Record<string, number>;
}
