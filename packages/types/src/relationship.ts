import type { Address, Confidence, Timestamp } from "./common.js";

/** Relationship types, see architecture.md §19. */
export type RelationshipType =
  | "FUNDED_BY"
  | "FUNDS"
  | "REPEATED_COUNTERPARTY"
  | "SHARED_COUNTERPARTY"
  | "SAME_ENTITY_INTERACTION"
  | "TIMING_CORRELATION"
  | "BEHAVIOR_SIMILARITY"
  | "ASSET_FLOW"
  | "SEQUENTIAL_ACTIVITY"
  | "POTENTIAL_CLUSTER_LINK";

export type RelationshipDirection = "INCOMING" | "OUTGOING" | "BIDIRECTIONAL";

export interface WalletRelationship {
  id: string;
  walletA: Address;
  walletB: Address;
  relationshipType: RelationshipType;
  direction: RelationshipDirection;
  transactionCount: number;
  interactionCount: number;
  totalValue: number;
  firstSeen: Timestamp;
  lastSeen: Timestamp;
  strengthScore: number; // 0 – 1
  confidenceScore: Confidence;
  evidenceJson: unknown;
  engineVersion: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Behavioral feature row, see architecture.md §21. */
export interface BehavioralFeature {
  id: string;
  walletId: string;
  featureName: string;
  featureValueNumber: number | null;
  featureValueJson: unknown;
  window: string;
  sampleSize: number;
  computedAt: Timestamp;
  engineVersion: string;
}

/** Behavioral fingerprint vector, see architecture.md §22. */
export interface BehavioralFingerprint {
  walletId: string;
  activityHourDistribution: Record<number, number>;
  weekdayDistribution: Record<number, number>;
  transferSizeDistribution: Record<string, number>;
  txIntervalDistribution: Record<string, number>;
  protocolDistribution: Record<string, number>;
  fundingPattern: Record<string, number>;
  counterpartyPattern: Record<string, number>;
  computedAt: Timestamp;
  engineVersion: string;
}
