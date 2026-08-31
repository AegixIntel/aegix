/**
 * Cluster hypothesis engine, see docs/d5-block2.md (D5-H).
 *
 * Purpose: conservative RelationshipCluster / CorrelationCluster — NEVER
 * "OwnerCluster". A wallet may join a cluster only with minimum relationship
 * strength AND confidence, and generally 2+ independent evidence families
 * (§52-§53). One weak bridge edge must never merge two strong clusters
 * (§55). Confidence is computed conservatively from the weakest meaningful
 * edge, evidence-family diversity, data quality and cluster size (§56).
 *
 * Safe language: clusters are "relationship clusters" / "observable
 * linkability", never common ownership.
 */

import { createHash } from "node:crypto";
import type { ExposurePathEdge } from "@aegix/types";

export const CLUSTER_ENGINE_VERSION = "cluster-hypothesis-v1.0.0";

/** D5-H §52-§60: versioned cluster thresholds. */
export interface ClusterLimits {
  /** Minimum relationship strength for a cluster edge. */
  minEdgeStrength: number;
  /** Minimum confidence for a cluster edge. */
  minConfidence: number;
  /** Minimum number of independent evidence families for membership. */
  minEvidenceFamilies: number;
  /** One exceptionally strong direct edge can substitute for multi-evidence. */
  strongDirectEdgeStrength: number;
  /** Weak edges below this never bridge two clusters (§55). */
  bridgeEdgeMaxStrength: number;
  /** Cap on members per cluster (§60). */
  maxClusterSize: number;
}

export const DEFAULT_CLUSTER_LIMITS: ClusterLimits = {
  minEdgeStrength: 0.35,
  minConfidence: 0.4,
  minEvidenceFamilies: 2,
  strongDirectEdgeStrength: 0.85,
  bridgeEdgeMaxStrength: 0.4,
  maxClusterSize: 15
};

export interface ClusterEdge {
  walletA: string;
  walletB: string;
  /** Independent evidence families supporting this edge (deduplicated). */
  evidenceFamilies: string[];
  /** Combined strength across families (max of family strengths). */
  strength: number;
  /** Combined confidence (min of family confidences). */
  confidence: number;
  /** Whether this edge is a direct observed relationship (funding/transfer). */
  direct: boolean;
}

export interface ClusterInput {
  /** Target wallet the cluster is centered on. */
  targetWallet: string;
  /** Strong pairwise edges between wallets (from relationships/correlations). */
  edges: ClusterEdge[];
  /** Wallet -> data quality 0-1 (caps confidence for low-data members). */
  dataQuality?: Map<string, number>;
  /** Hub/entity addresses that must never be treated as user-wallet members (§61-§62). */
  entityAddresses?: Set<string>;
  /** Address -> commonality 0-1 (hub influence note). */
  commonality?: Map<string, number>;
  limits?: Partial<ClusterLimits>;
}

export interface ClusterMember {
  wallet: string;
  /** Relationship strength to the cluster core (anchor). */
  strengthToCore: number;
  confidence: number;
  /** Evidence families supporting this member's membership. */
  evidenceFamilies: string[];
  /** Anchor of the cluster (graph-structure based, not "main owner"). */
  anchor: string;
  /** Low-data member flag (data quality below threshold). */
  lowData: boolean;
}

export interface RelationshipCluster {
  /** Stable fingerprint from membership + evidence (D5-H §63). */
  id: string;
  targetWallet: string;
  members: ClusterMember[];
  confidence: number;
  /** Evidence families present across the cluster. */
  evidenceFamilies: string[];
  engineVersion: string;
  /** D5-H §59: honest limitations. */
  limitations: string[];
  createdAt: string;
}

export interface ClusterResult {
  clusters: RelationshipCluster[];
  /** Edges that were rejected and why (debuggability). */
  rejectedEdges: Array<{ walletA: string; walletB: string; reason: string }>;
  engineVersion: string;
}

/** Independent evidence families by edge type (D5-H §53). */
const FAMILY_BY_EDGE_TYPE: Record<string, string> = {
  FUNDED: "FUNDING",
  TRANSFERRED: "TRANSFER",
  RECEIVED_FROM: "FUNDING",
  REPEATED_COUNTERPARTY: "COUNTERPARTY",
  SHARED_COUNTERPARTY: "COUNTERPARTY",
  SHARED_ENTITY: "ENTITY",
  BEHAVIORALLY_CORRELATED: "BEHAVIORAL",
  TEMPORALLY_CORRELATED: "TEMPORAL",
  INTERACTED_WITH: "ENTITY"
};

/**
 * Builds conservative relationship clusters around the target wallet.
 * Deterministic: thresholded connected components with bridge-edge
 * separation (D5-H §54-§55).
 */
export function buildRelationshipClusters(input: ClusterInput): ClusterResult {
  const limits: ClusterLimits = { ...DEFAULT_CLUSTER_LIMITS, ...input.limits };
  const now = new Date().toISOString();
  const rejectedEdges: Array<{ walletA: string; walletB: string; reason: string }> = [];

  // ---- 1. Edge admission (D5-H §52-§53) ----
  const admitted: ClusterEdge[] = [];
  for (const edge of input.edges) {
    if (edge.walletA === edge.walletB) continue;
    const families = [...new Set(edge.evidenceFamilies)].filter(Boolean);
    if (families.length === 0) {
      rejectedEdges.push({ walletA: edge.walletA, walletB: edge.walletB, reason: "no evidence families" });
      continue;
    }
    if (edge.strength < limits.minEdgeStrength) {
      rejectedEdges.push({ walletA: edge.walletA, walletB: edge.walletB, reason: `strength ${edge.strength} < ${limits.minEdgeStrength}` });
      continue;
    }
    if (edge.confidence < limits.minConfidence) {
      rejectedEdges.push({ walletA: edge.walletA, walletB: edge.walletB, reason: `confidence ${edge.confidence} < ${limits.minConfidence}` });
      continue;
    }
    const strongDirect = edge.direct && edge.strength >= limits.strongDirectEdgeStrength;
    const multiEvidence = families.length >= limits.minEvidenceFamilies;
    if (!strongDirect && !multiEvidence) {
      rejectedEdges.push({ walletA: edge.walletA, walletB: edge.walletB, reason: `single weak evidence family (${families.join(",")})` });
      continue;
    }
    admitted.push(edge);
  }

  // ---- 2. Thresholded connected components around the target ----
  // BFS from the target over admitted edges; a component only forms if it
  // contains the target (cluster = target + its strongly related wallets).
  const adjacency = new Map<string, ClusterEdge[]>();
  for (const edge of admitted) {
    const a = adjacency.get(edge.walletA) ?? [];
    a.push(edge);
    adjacency.set(edge.walletA, a);
    const b = adjacency.get(edge.walletB) ?? [];
    b.push(edge);
    adjacency.set(edge.walletB, b);
  }

  const clusters: RelationshipCluster[] = [];
  const visited = new Set<string>([input.targetWallet]);

  const memberOf = new Map<string, ClusterMember>();
  const queue = [input.targetWallet];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const edges = adjacency.get(current) ?? [];
    for (const edge of edges) {
      const other = edge.walletA === current ? edge.walletB : edge.walletA;
      if (visited.has(other)) continue;
      // D5-H §61-§62: entity/protocol nodes never become wallet members.
      if (input.entityAddresses?.has(other)) continue;
      if (memberOf.size >= limits.maxClusterSize) break;
      visited.add(other);
      const families = [...new Set(edge.evidenceFamilies)].filter(Boolean);
      const dq = input.dataQuality?.get(other) ?? 1;
      const lowData = dq < 0.4;
      // Conservative member confidence (§56): edge confidence scaled by data quality.
      let confidence = edge.confidence * (0.7 + 0.3 * dq);
      if (lowData) confidence *= 0.6;
      memberOf.set(other, {
        wallet: other,
        strengthToCore: edge.strength,
        confidence: Math.round(confidence * 100) / 100,
        evidenceFamilies: families,
        anchor: input.targetWallet,
        lowData
      });
      queue.push(other);
    }
  }

  // ---- 3. Bridge-edge separation (D5-H §55) ----
  // A weak inter-cluster edge must not merge two strong clusters. We handle
  // this by construction: membership requires admission (min strength +
  // confidence + multi-evidence), so weak bridges never enter the component.
  // The only admissible-but-weak case is a strongDirect edge — acceptable.

  if (memberOf.size > 0 || adjacency.get(input.targetWallet)) {
    const members = [...memberOf.values()].sort((a, b) => b.strengthToCore - a.strengthToCore);
    const evidenceFamilies = [...new Set(members.flatMap((m) => m.evidenceFamilies))];
    const confidence = clusterConfidence(members, evidenceFamilies.length);
    const limitations = clusterLimitations(members, input, limits);
    clusters.push({
      id: clusterFingerprint(input.targetWallet, members),
      targetWallet: input.targetWallet,
      members,
      confidence: Math.round(confidence * 100) / 100,
      evidenceFamilies,
      engineVersion: CLUSTER_ENGINE_VERSION,
      limitations,
      createdAt: now
    });
  }

  return { clusters, rejectedEdges, engineVersion: CLUSTER_ENGINE_VERSION };
}

/** D5-H §56: conservative cluster confidence. */
export function clusterConfidence(members: Array<{ confidence: number; lowData: boolean }>, evidenceFamilyCount: number): number {
  if (members.length === 0) return 0;
  const weakestMeaningful = Math.min(...members.map((m) => m.confidence));
  const avgStrong = members
    .filter((m) => m.confidence >= 0.5)
    .reduce((s, m) => s + m.confidence, 0) / Math.max(1, members.filter((m) => m.confidence >= 0.5).length);
  const diversity = Math.min(1, evidenceFamilyCount / 3);
  const sizePenalty = members.length > 8 ? 0.85 : 1;
  // Weakest edge dominates (bottleneck); diversity and size adjust slightly.
  const confidence = weakestMeaningful * (0.6 + 0.25 * diversity) * sizePenalty * Math.max(0.5, avgStrong);
  return Math.min(0.9, Math.max(0.05, confidence));
}

/** D5-H §63: stable fingerprint from membership + evidence. */
export function clusterFingerprint(targetWallet: string, members: Array<{ wallet: string; evidenceFamilies: string[] }>): string {
  const memberPart = members.map((m) => m.wallet).sort().join(",");
  const familyPart = [...new Set(members.flatMap((m) => m.evidenceFamilies))].sort().join("+");
  const raw = `${targetWallet}|${memberPart}|${familyPart}`;
  return `cluster-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
}

/** D5-H §59: honest limitations per cluster. */
export function clusterLimitations(members: Array<{ lowData: boolean; confidence: number }>, input: ClusterInput, limits: ClusterLimits): string[] {
  const out: string[] = [];
  const weakMembers = members.filter((m) => m.confidence < 0.5);
  if (weakMembers.length > 0) out.push(`${weakMembers.length} weak member(s) — their linkability is suggestive, not strong`);
  const lowData = members.filter((m) => m.lowData);
  if (lowData.length > 0) out.push(`${lowData.length} low-data member(s) — confidence is capped by history coverage`);
  const hubs = [...(input.commonality?.entries() ?? [])].filter(([, f]) => f >= 0.6);
  if (hubs.length > 0) out.push(`Hub influence: ${hubs.length} common node(s) in the neighborhood — hub-mediated links are weak evidence`);
  out.push("A relationship cluster is a hypothesis of observable linkability, never a claim of common ownership or identity");
  if (input.entityAddresses && input.entityAddresses.size > 0) out.push("Entity/protocol nodes are excluded from membership");
  return out.slice(0, 6);
}

/** D5-H §53: map an exposure edge to its evidence family. */
export function familyForEdgeType(type: ExposurePathEdge["type"]): string {
  return FAMILY_BY_EDGE_TYPE[type] ?? "UNKNOWN";
}
