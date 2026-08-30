import type { Address, Confidence, Timestamp } from "./common.js";

export type ExposurePathNodeType = "WALLET" | "ENTITY" | "PROTOCOL" | "CLUSTER" | "PUBLIC_SIGNAL";

export type ExposurePathEdgeType =
  | "FUNDED"
  | "TRANSFERRED"
  | "INTERACTED_WITH"
  | "BEHAVIOR_SIMILAR"
  | "SHARED_COUNTERPARTY"
  | "RELATED_CLUSTER"
  | "ASSOCIATED_ENTITY"
  | "PUBLICLY_ATTRIBUTED";

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
}

export interface ExposurePath {
  id: string;
  analysisId: string;
  targetWalletId: string;
  rank: number;
  pathType: string;
  nodes: ExposurePathNode[];
  edges: ExposurePathEdge[];
  pathScore: number;
  confidenceScore: Confidence;
  summary: string;
  createdAt: Timestamp;
  engineVersion: string;
}

/** Graph expansion limits, see architecture.md §32. */
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
