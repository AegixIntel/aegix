import type { Address, Confidence, Timestamp } from "./common.js";

export type ExposurePathNodeType = "WALLET" | "ENTITY" | "PROTOCOL" | "CLUSTER" | "PUBLIC_SIGNAL";

export type ExposurePathEdgeType =
  | "FUNDED"
  | "TRANSFERRED"
  | "RECEIVED_FROM"
  | "REPEATED_COUNTERPARTY"
  | "SHARED_COUNTERPARTY"
  | "SHARED_ENTITY"
  | "BEHAVIORALLY_CORRELATED"
  | "TEMPORALLY_CORRELATED"
  | "INTERACTED_WITH"
  | "BEHAVIOR_SIMILAR"
  | "RELATED_CLUSTER"
  | "ASSOCIATED_ENTITY"
  | "PUBLICLY_ATTRIBUTED";

/**
 * D5-G §35: classification of an edge's origin — direct/observed vs
 * inferred/correlation.
 */
export type EdgeObservationClass = "OBSERVED" | "INFERRED";

export interface ExposurePathNode {
  id: string;
  type: ExposurePathNodeType;
  label: string;
}

export interface ExposurePathEdge {
  source: string;
  target: string;
  type: ExposurePathEdgeType;
  strength: number;
  confidence: Confidence;
  /** D5-G §36: direct/observed vs inferred/correlation edge. */
  observationClass: EdgeObservationClass;
  /** D5-G §36: concrete evidence references (signatures, tx ids, …). */
  evidence: string[];
  /** D5-G §36: source engine that produced this edge. */
  sourceEngine: string;
  /** D5-G §36: engine version of the source. */
  engineVersion: string;
}

export interface ExposurePath {
  id: string;
  analysisId: string;
  targetWalletId: string;
  rank: number;
  /** D5-G §42: OBSERVED_PATH | INFERRED_PATH | MIXED_PATH. */
  pathType: string;
  nodes: ExposurePathNode[];
  edges: ExposurePathEdge[];
  pathScore: number;
  confidenceScore: Confidence;
  summary: string;
  /** D5-G §48: why this path matters / what weakens it. */
  explanation: string[];
  createdAt: Timestamp;
  engineVersion: string;
}

/** Graph expansion limits, see architecture.md §32 and docs/d5-block2.md (D5-G §33). */
export interface GraphLimits {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxCounterpartiesPerNode: number;
  minEdgeStrength: number;
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
  maxDepth: 4,
  maxNodes: 500,
  maxEdges: 2000,
  maxCounterpartiesPerNode: 30,
  minEdgeStrength: 0.25
};
