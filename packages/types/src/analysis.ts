import type { Address, Chain, Confidence, ScoreValue, Timestamp } from "./common.js";
import type { EntityType } from "./entity.js";
import type { RelationshipDirection, RelationshipType } from "./relationship.js";
import type { SignalCategory } from "./signal.js";

/** State machine of an analysis job, see architecture.md §9. */
export type AnalysisStatus =
  | "CREATED"
  | "QUEUED"
  | "FETCHING"
  | "NORMALIZING"
  | "ENTITY_ANALYSIS"
  | "RELATIONSHIP_ANALYSIS"
  | "BEHAVIOR_ANALYSIS"
  | "SCORING"
  | "GRAPH_ANALYSIS"
  | "EXPLANATION"
  | "PERSISTING"
  | "READY"
  | "FAILED"
  | "PARTIAL"
  | "CANCELLED";

export type AnalysisType = "full" | "attack";

export type AnalysisPriority = "high" | "standard" | "free";

export interface Wallet {
  id: string;
  chain: Chain;
  address: Address;
  firstObservedAt: Timestamp | null;
  lastObservedAt: Timestamp | null;
  lastAnalyzedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AnalysisJob {
  id: string;
  walletId: string;
  requestedBy: string | null; // user id or null for anonymous
  analysisType: AnalysisType;
  status: AnalysisStatus;
  priority: AnalysisPriority;
  progress: number; // 0 – 100
  engineVersion: string | null;
  requestedAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  failedAt: Timestamp | null;
  failureCode: string | null;
  failureMessage: string | null;
}

/** Freshness model of an analysis, see architecture.md §43. */
export interface DataFreshness {
  analysisStartedAt: Timestamp;
  chainDataUntil: Timestamp | null;
  analysisCompletedAt: Timestamp;
  freshUntil: Timestamp | null;
}

/** Data quality / coverage report, see architecture.md §137. */
export interface DataQuality {
  transactionsRequested: number;
  transactionsReceived: number;
  transactionsParsed: number;
  parserFailures: number;
  historyStart: Timestamp | null;
  historyEnd: Timestamp | null;
  providerFailures: number;
}

export interface WalletXRayResponse {
  wallet: Address;
  analysisId: string;
  status: AnalysisStatus;
  score: {
    overall: ScoreValue;
    confidence: Confidence;
  };
  dimensions: Record<string, number>;
  topSignals: SignalSummary[];
  entities: EntityExposureSummary[];
  relationships: RelationshipSummary[];
  behavioralSummary: Record<string, number | string>;
  engineVersion: string;
  dataQuality: DataQuality;
}

export interface SignalSummary {
  id: string;
  type: string;
  category: SignalCategory;
  severity: number;
  confidence: Confidence;
  title: string;
}

export interface EntityExposureSummary {
  entityId: string;
  name: string;
  entityType: EntityType;
  confidence: Confidence;
  interactionCount: number;
}

export interface RelationshipSummary {
  counterparty: Address;
  relationshipType: RelationshipType;
  direction: RelationshipDirection;
  transactionCount: number;
  strengthScore: number;
  confidenceScore: Confidence;
}

