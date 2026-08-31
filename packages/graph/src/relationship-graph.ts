/**
 * Multi-hop relationship graph engine, see docs/d5-block2.md (D5-G).
 *
 * Goal (D5-G §32): find BOUNDED, meaningful relationship paths — never
 * crawl all reachable Solana addresses. Expansion is strictly budgeted
 * (nodes/edges/depth/time), hubs are penalized (D5-G §37-§38), and path
 * confidence decays through the weakest edge (bottleneck, D5-G §40-§41).
 *
 * Edge model (D5-G §35-§36): every edge carries type, direction, strength,
 * confidence, OBSERVED/INFERRED class, evidence references, source engine
 * and engine version. Paths are classified OBSERVED_PATH / INFERRED_PATH /
 * MIXED_PATH (§42) and deduplicated on reorder-insensitive identity (§43-§44).
 *
 * Safe language: paths are "relationship paths", never ownership claims.
 */

import { createHash } from "node:crypto";
import type { ExposurePath, ExposurePathEdge, ExposurePathEdgeType, ExposurePathNode, GraphLimits, WalletRelationship } from "@aegix/types";
import { DEFAULT_GRAPH_LIMITS } from "@aegix/types";

export const RELATIONSHIP_GRAPH_ENGINE_VERSION = "relationship-graph-v1.0.0";

/** D5-G §33: bounded expansion configuration (versioned, no unbounded defaults). */
export interface RelationshipGraphLimits extends GraphLimits {
  /** Max secondary wallets fetched (D5-G §33). */
  maxSecondaryWallets: number;
  /** Max secondary RPC fetches (D5-G §33). */
  maxSecondaryRpcCalls: number;
  /** Hard wall-clock budget for expansion (D5-G §33). */
  maxGraphTimeMs: number;
  /** Hub commonality factor at which an edge is heavily penalized (0-1). */
  hubPenaltyThreshold: number;
  /** Max candidate paths enumerated before ranking (diversity cap). */
  maxPaths: number;
}

export const DEFAULT_RELATIONSHIP_GRAPH_LIMITS: RelationshipGraphLimits = {
  maxDepth: 4,
  maxNodes: 200,
  maxEdges: 800,
  maxCounterpartiesPerNode: 30,
  minEdgeStrength: 0.2,
  maxSecondaryWallets: 20,
  maxSecondaryRpcCalls: 40,
  maxGraphTimeMs: 5000,
  hubPenaltyThreshold: 0.6,
  maxPaths: 400
};

/** Why graph expansion stopped (D5-G §47). */
export type GraphStopReason =
  | "MAX_DEPTH"
  | "MAX_NODES"
  | "MAX_EDGES"
  | "RPC_BUDGET"
  | "TIME_BUDGET"
  | "PATH_BUDGET"
  | "LOW_EDGE_STRENGTH"
  | "NO_NEW_RELATIONSHIPS";

/** A normalized graph edge with full metadata (D5-G §36). */
export interface RelationshipEdge {
  source: string;
  target: string;
  type: ExposurePathEdgeType;
  /** Directional: A->B or B->A; undirected edges use "A|B" semantics. */
  direction: "A_TO_B" | "B_TO_A" | "UNDIRECTED";
  strength: number;
  confidence: number;
  observationClass: "OBSERVED" | "INFERRED";
  evidence: string[];
  sourceEngine: string;
  engineVersion: string;
  /** 0-1 commonality: how often this node appears as counterparty/hub. */
  hubFactor: number;
}

export interface RelationshipGraphInput {
  targetWallet: string;
  /** Known nodes (with optional entity/protocol annotation). */
  nodes?: Map<string, ExposurePathNode>;
  /** Direct wallet relationships (persisted wallet_relationships). */
  relationships: WalletRelationship[];
  /** Inferred/correlation edges (e.g. from the correlation engine). */
  inferredEdges?: Array<{
    walletA: string;
    walletB: string;
    type: ExposurePathEdgeType;
    strength: number;
    confidence: number;
    evidence: string[];
    sourceEngine: string;
    engineVersion: string;
  }>;
  /** Address -> commonality factor 0-1 (known hubs/entities from the registry). */
  commonality?: Map<string, number>;
  /** Bounded fetcher for secondary wallet relationships (persisted data first). */
  fetchRelationships?: (walletAddress: string) => Promise<WalletRelationship[]>;
  limits?: Partial<RelationshipGraphLimits>;
  now?: Date;
}

export interface RelationshipPathResult {
  path: ExposurePath;
  /** Reorder-insensitive identity for dedup (D5-G §44). */
  identity: string;
  /** Why this path is meaningful / what weakens it (D5-G §48). */
  explanation: string[];
}

export interface RelationshipGraphResult {
  paths: RelationshipPathResult[];
  nodes: ExposurePathNode[];
  edges: ExposurePathEdge[];
  /** D5-G §46: fetch budget accounting. */
  secondaryWalletsFetched: number;
  rpcCallsConsumed: number;
  rpcBudgetRemaining: number;
  /** D5-G §47. */
  stopReason: GraphStopReason;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  engineVersion: string;
}

interface GraphNodeInternal {
  id: string;
  type: ExposurePathNode["type"];
  label: string;
  hubFactor: number;
}

interface GraphEdgeInternal extends RelationshipEdge {
  key: string; // canonical sorted pair
}

/**
 * Builds the bounded relationship graph and finds meaningful multi-hop paths.
 *
 * Expansion order (D5-G §45): persisted relationships → inferred edges →
 * bounded secondary fetch. Secondary wallets are only fetched when needed
 * and always within budget.
 */
export async function findRelationshipPaths(input: RelationshipGraphInput): Promise<RelationshipGraphResult> {
  const started = Date.now();
  const limits: RelationshipGraphLimits = { ...DEFAULT_RELATIONSHIP_GRAPH_LIMITS, ...input.limits };
  const target = input.targetWallet;
  const now = input.now ?? new Date();

  // ---- Build the local graph from persisted data (no RPC yet) ----
  const nodes = new Map<string, GraphNodeInternal>();
  const edges = new Map<string, GraphEdgeInternal>();
  const directNeighbors = new Set<string>();

  const ensureNode = (id: string, fallbackType: ExposurePathNode["type"]): void => {
    if (nodes.has(id)) return;
    const annotated = input.nodes?.get(id);
    nodes.set(id, {
      id,
      type: annotated?.type ?? fallbackType,
      label: annotated?.label ?? id,
      hubFactor: input.commonality?.get(id) ?? 0
    });
  };

  const addEdge = (edge: RelationshipEdge): void => {
    const key = [edge.source, edge.target].sort().join("|");
    const existing = edges.get(key);
    if (existing) {
      // Merge: keep the stronger/observed edge; accumulate evidence.
      if (edge.observationClass === "OBSERVED") existing.observationClass = "OBSERVED";
      if (edge.strength > existing.strength) {
        existing.strength = edge.strength;
        existing.confidence = edge.confidence;
        existing.type = edge.type;
      }
      existing.evidence = [...new Set([...existing.evidence, ...edge.evidence])].slice(0, 10);
      return;
    }
    edges.set(key, { ...edge, key });
  };

  for (const rel of input.relationships) {
    ensureNode(rel.walletA, "WALLET");
    ensureNode(rel.walletB, "WALLET");
    const type = rel.relationshipType === "FUNDED_BY" || rel.relationshipType === "FUNDS"
      ? "FUNDED"
      : rel.relationshipType === "REPEATED_COUNTERPARTY"
        ? "REPEATED_COUNTERPARTY"
        : "TRANSFERRED";
    addEdge({
      source: rel.walletA,
      target: rel.walletB,
      type,
      direction: rel.direction === "INCOMING" ? "B_TO_A" : rel.direction === "OUTGOING" ? "A_TO_B" : "UNDIRECTED",
      strength: rel.strengthScore,
      confidence: rel.confidenceScore,
      observationClass: "OBSERVED",
      evidence: Array.isArray(rel.evidenceJson) ? (rel.evidenceJson as string[]) : [String(rel.evidenceJson ?? "")].filter(Boolean),
      sourceEngine: rel.engineVersion ?? "wallet-relationships",
      engineVersion: rel.engineVersion ?? "unknown",
      hubFactor: Math.max(input.commonality?.get(rel.walletA) ?? 0, input.commonality?.get(rel.walletB) ?? 0)
    });
    // Track depth-1 neighbors so we know when the direct frontier is done.
    if (rel.walletA === target) directNeighbors.add(rel.walletB);
    if (rel.walletB === target) directNeighbors.add(rel.walletA);
  }

  for (const inf of input.inferredEdges ?? []) {
    ensureNode(inf.walletA, "WALLET");
    ensureNode(inf.walletB, "WALLET");
    addEdge({
      source: inf.walletA,
      target: inf.walletB,
      type: inf.type,
      direction: "UNDIRECTED",
      strength: inf.strength,
      confidence: inf.confidence,
      observationClass: "INFERRED",
      evidence: inf.evidence,
      sourceEngine: inf.sourceEngine,
      engineVersion: inf.engineVersion,
      hubFactor: Math.max(input.commonality?.get(inf.walletA) ?? 0, input.commonality?.get(inf.walletB) ?? 0)
    });
    if (inf.walletA === target) directNeighbors.add(inf.walletB);
    if (inf.walletB === target) directNeighbors.add(inf.walletA);
  }

  // ---- Bounded secondary expansion (D5-G §45-§46) ----
  let secondaryWalletsFetched = 0;
  let rpcCallsConsumed = 0;
  const rpcBudget = limits.maxSecondaryRpcCalls;
  const expanded = new Set<string>([target]);
  const frontier = [...directNeighbors];
  let stopReason: GraphStopReason = "NO_NEW_RELATIONSHIPS";

  while (frontier.length > 0) {
    if (Date.now() - started > limits.maxGraphTimeMs) { stopReason = "TIME_BUDGET"; break; }
    if (nodes.size >= limits.maxNodes) { stopReason = "MAX_NODES"; break; }
    if (edges.size >= limits.maxEdges) { stopReason = "MAX_EDGES"; break; }
    if (secondaryWalletsFetched >= limits.maxSecondaryWallets) { stopReason = "RPC_BUDGET"; break; }
    if (rpcCallsConsumed >= rpcBudget) { stopReason = "RPC_BUDGET"; break; }

    const current = frontier.shift()!;
    if (expanded.has(current)) continue;
    expanded.add(current);

    if (!input.fetchRelationships) { stopReason = "NO_NEW_RELATIONSHIPS"; break; }
    secondaryWalletsFetched += 1;
    rpcCallsConsumed += 1;
    let rows: WalletRelationship[];
    try {
      rows = await input.fetchRelationships(current);
    } catch {
      rows = [];
    }
    const related = rows
      .filter((r) => r.strengthScore >= limits.minEdgeStrength)
      .sort((a, b) => b.strengthScore - a.strengthScore)
      .slice(0, limits.maxCounterpartiesPerNode);
    let added = 0;
    for (const rel of related) {
      if (edges.size >= limits.maxEdges) { stopReason = "MAX_EDGES"; break; }
      const other = rel.walletA === current ? rel.walletB : rel.walletA;
      ensureNode(other, "WALLET");
      addEdge({
        source: current,
        target: other,
        type: rel.relationshipType === "FUNDED_BY" || rel.relationshipType === "FUNDS" ? "FUNDED" : "TRANSFERRED",
        direction: "UNDIRECTED",
        strength: rel.strengthScore,
        confidence: rel.confidenceScore,
        observationClass: "OBSERVED",
        evidence: [],
        sourceEngine: rel.engineVersion ?? "wallet-relationships",
        engineVersion: rel.engineVersion ?? "unknown",
        hubFactor: input.commonality?.get(other) ?? 0
      });
      frontier.push(other);
      added += 1;
    }
    if (added === 0) continue;
  }
  if (stopReason === "NO_NEW_RELATIONSHIPS" && expanded.size > 1) stopReason = "MAX_DEPTH";

  // ---- Path finding with hub penalty and bottleneck confidence ----
  const paths: RelationshipPathResult[] = [];
  const seenIdentities = new Set<string>();
  const targetNode = nodes.get(target);
  if (targetNode) {
    type FrontierEntry = { nodeId: string; depth: number; path: string[]; edgeKeys: string[]; strength: number; confidence: number; hubs: number };
    const stack: FrontierEntry[] = [{ nodeId: target, depth: 0, path: [target], edgeKeys: [], strength: 1, confidence: 1, hubs: 0 }];

    while (stack.length > 0) {
      if (Date.now() - started > limits.maxGraphTimeMs) { stopReason = "TIME_BUDGET"; break; }
      const current = stack.pop()!;
      // maxDepth = maximum number of hops on a path (D5-G §34).
      if (current.depth >= limits.maxDepth) continue;

      for (const edge of edges.values()) {
        if (edge.strength < limits.minEdgeStrength) continue;
        const neighbor = edge.source === current.nodeId ? edge.target : edge.target === current.nodeId ? edge.source : null;
        if (!neighbor || current.path.includes(neighbor)) continue;

        // Hub penalty (D5-G §37-§38): edges through common hubs are near-useless.
        const nodeHub = nodes.get(neighbor)?.hubFactor ?? 0;
        const hubPenalty = nodeHub >= limits.hubPenaltyThreshold ? 0.25 : 1 - nodeHub * 0.5;
        const edgeStrength = edge.strength * hubPenalty;
        if (edgeStrength < limits.minEdgeStrength) continue;

        const nextPath = [...current.path, neighbor];
        const nextEdgeKeys = [...current.edgeKeys, edge.key];
        const nextHubs = current.hubs + (nodeHub >= limits.hubPenaltyThreshold ? 1 : 0);

        // Path strength: product of hub-penalized edge strengths (D5-G §39).
        const strength = current.strength * edgeStrength;
        // Bottleneck confidence (D5-G §40-§41): min edge confidence, decayed by depth.
        const confidence = Math.min(current.confidence, edge.confidence) * (1 - 0.12 * current.depth);

        // Report every bounded path (dedup by reorder-insensitive identity).
        // Meaningfulness comes from minEdgeStrength + hub penalty + ranking;
        // the path budget caps enumeration (D5-G §43).
        const pathEdges = nextEdgeKeys.map((key) => toExposureEdge(edges.get(key)!, nodes));
        const pathType = classifyPathType(pathEdges);
        const identity = canonicalPathIdentity(nextPath, pathEdges);
        const explanation = explainPath(nextPath, pathEdges, nodes, edgeStrength, confidence, nextHubs);
        const existingIdx = seenIdentities.has(identity) ? paths.findIndex((p) => p.identity === identity) : -1;
        if (existingIdx >= 0) {
          // Keep the stronger variant of the same semantic path.
          if (strength > paths[existingIdx]!.path.pathScore) {
            paths[existingIdx] = {
              path: { ...paths[existingIdx]!.path, pathScore: Math.round(strength * 100) / 100, confidenceScore: Math.round(confidence * 100) / 100 },
              identity,
              explanation
            };
          }
        } else {
          if (paths.length >= limits.maxPaths) { stopReason = "PATH_BUDGET"; break; }
          seenIdentities.add(identity);
          paths.push({
            path: {
              id: `rpath-${hash8(identity)}`,
              analysisId: "",
              targetWalletId: target,
              rank: 0,
              pathType,
              nodes: nextPath.map((id) => toExposureNode(nodes.get(id)!)),
              edges: pathEdges,
              pathScore: Math.round(strength * 100) / 100,
              confidenceScore: Math.round(confidence * 100) / 100,
              summary: `${pathType}: ${nextPath.length - 1} hop(s) from ${target.slice(0, 6)}… to ${neighbor.slice(0, 6)}…`,
              explanation,
              createdAt: now.toISOString(),
              engineVersion: RELATIONSHIP_GRAPH_ENGINE_VERSION
            },
            identity,
            explanation
          });
        }

        stack.push({ nodeId: neighbor, depth: current.depth + 1, path: nextPath, edgeKeys: nextEdgeKeys, strength, confidence, hubs: nextHubs });
      }
    }
  }

  // Rank: path score desc, then confidence desc (D5-G §39).
  paths.sort((a, b) => b.path.pathScore - a.path.pathScore || b.path.confidenceScore - a.path.confidenceScore);
  paths.forEach((p, i) => { p.path.rank = i + 1; });

  return {
    paths: paths.slice(0, 10),
    nodes: [...nodes.values()].map((n) => toExposureNode(n)),
    edges: [...edges.values()].map((e) => toExposureEdge(e, nodes)),
    secondaryWalletsFetched,
    rpcCallsConsumed,
    rpcBudgetRemaining: Math.max(0, rpcBudget - rpcCallsConsumed),
    stopReason,
    nodeCount: nodes.size,
    edgeCount: edges.size,
    durationMs: Date.now() - started,
    engineVersion: RELATIONSHIP_GRAPH_ENGINE_VERSION
  };
}

/** D5-G §42: classify a path by its edges' observation classes. */
export function classifyPathType(edges: ExposurePathEdge[]): "OBSERVED_PATH" | "INFERRED_PATH" | "MIXED_PATH" {
  const observed = edges.some((e) => e.observationClass === "OBSERVED");
  const inferred = edges.some((e) => e.observationClass === "INFERRED");
  if (observed && inferred) return "MIXED_PATH";
  return observed ? "OBSERVED_PATH" : "INFERRED_PATH";
}

/** D5-G §44: reorder-insensitive path identity (sorted node set + edge set). */
export function canonicalPathIdentity(nodes: string[], edges: ExposurePathEdge[]): string {
  const nodePart = [...nodes].sort().join(",");
  const edgePart = edges
    .map((e) => `${[e.source, e.target].sort().join("|")}:${e.type}`)
    .sort()
    .join(";");
  return `${nodePart}::${edgePart}`;
}

/** D5-G §48: human-readable path explanation. */
export function explainPath(
  nodes: string[],
  edges: ExposurePathEdge[],
  nodeMap: Map<string, GraphNodeInternal>,
  finalEdgeStrength: number,
  confidence: number,
  hubCount: number
): string[] {
  const out: string[] = [];
  const observed = edges.filter((e) => e.observationClass === "OBSERVED").length;
  const inferred = edges.length - observed;
  out.push(`${edges.length} edge(s): ${observed} observed, ${inferred} inferred`);
  if (hubCount > 0) out.push(`${hubCount} hub node(s) on this path — hub-mediated links are weak evidence`);
  if (inferred > 0) out.push("Inferred edges carry less weight than observed transfers");
  if (confidence < 0.5) out.push(`Path confidence is limited by the weakest edge (${Math.round(confidence * 100)}%)`);
  if (edges.some((e) => e.strength < 0.3)) out.push("At least one edge is weak — treat this path as suggestive, not strong");
  const terminus = nodes[nodes.length - 1]!;
  const terminusNode = nodeMap.get(terminus);
  if (terminusNode?.type === "ENTITY") out.push(`Path terminates at verified entity ${terminusNode.label}`);
  out.push("Relationship paths describe observable linkability, never ownership");
  return out;
}

function toExposureEdge(edge: GraphEdgeInternal, nodeMap: Map<string, GraphNodeInternal>): ExposurePathEdge {
  return {
    source: edge.source,
    target: edge.target,
    type: edge.type,
    strength: Math.round(edge.strength * 100) / 100,
    confidence: Math.round(edge.confidence * 100) / 100,
    observationClass: edge.observationClass,
    evidence: edge.evidence,
    sourceEngine: edge.sourceEngine,
    engineVersion: edge.engineVersion
  };
}

function toExposureNode(node: GraphNodeInternal): ExposurePathNode {
  return { id: node.id, type: node.type, label: node.label };
}

function hash8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
