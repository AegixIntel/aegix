import {
  DEFAULT_GRAPH_LIMITS,
  type Confidence,
  type ExposurePath,
  type ExposurePathEdge,
  type ExposurePathEdgeType,
  type ExposurePathNode,
  type ExposurePathNodeType,
  type GraphLimits,
  type WalletRelationship
} from "@aegix/types";

export const GRAPH_ENGINE_VERSION = "graph-v1.0.0";

export interface GraphNode {
  id: string;
  type: ExposurePathNodeType;
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: ExposurePathEdgeType;
  strength: number;
  confidence: Confidence;
}

export interface WalletGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

/** Builds an undirected graph from wallet relationships. */
export function buildGraph(relationships: WalletRelationship[]): WalletGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const ensureNode = (id: string, type: ExposurePathNodeType, label: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, label });
  };

  for (const rel of relationships) {
    ensureNode(rel.walletA, "WALLET", rel.walletA);
    ensureNode(rel.walletB, "WALLET", rel.walletB);
    const key = [rel.walletA, rel.walletB].sort().join("|");
    const existing = edges.get(key);
    const type = rel.relationshipType === "FUNDED_BY" ? "FUNDED" : "TRANSFERRED";
    if (existing) {
      existing.strength = Math.max(existing.strength, rel.strengthScore);
      existing.confidence = Math.max(existing.confidence, rel.confidenceScore);
    } else {
      edges.set(key, {
        source: rel.walletA,
        target: rel.walletB,
        type,
        strength: rel.strengthScore,
        confidence: rel.confidenceScore
      });
    }
  }

  return { nodes, edges };
}

export interface EntityAnnotation {
  address: string;
  entityName: string;
}

/**
 * Annotates wallet nodes that are known entities, converting WALLET nodes
 * to ENTITY nodes when a match exists.
 */
export function annotateEntities(graph: WalletGraph, annotations: EntityAnnotation[]): void {
  const byAddress = new Map(annotations.map((a) => [a.address, a]));
  for (const [id, node] of graph.nodes) {
    const annotation = byAddress.get(id);
    if (annotation) {
      node.type = "ENTITY";
      node.label = annotation.entityName;
    }
  }
}

export interface PathFindingInput {
  targetAddress: string;
  graph: WalletGraph;
  limits?: Partial<GraphLimits>;
}

export interface PathFindingResult {
  paths: ExposurePath[];
  nodes: ExposurePathNode[];
  edges: ExposurePathEdge[];
}

/**
 * Attack My Wallet path engine, see architecture.md §29-§34.
 * Performs bounded BFS from the target wallet and ranks candidate
 * attribution paths by edge strength product and confidence.
 */
export function findExposurePaths(input: PathFindingInput): PathFindingResult {
  const limits: GraphLimits = { ...DEFAULT_GRAPH_LIMITS, ...input.limits };
  const { graph, targetAddress } = input;

  const allNodes: ExposurePathNode[] = [];
  const allEdges: ExposurePathEdge[] = [];
  const seenNodes = new Set<string>();

  const paths: ExposurePath[] = [];
  const targetNode = graph.nodes.get(targetAddress);
  if (!targetNode) return { paths, nodes: allNodes, edges: allEdges };

  type FrontierEntry = { nodeId: string; depth: number; path: string[]; strength: number; confidence: number };
  const frontier: FrontierEntry[] = [{ nodeId: targetAddress, depth: 0, path: [targetAddress], strength: 1, confidence: 1 }];
  let nodeCount = 0;
  let edgeCount = 0;

  while (frontier.length > 0 && nodeCount < limits.maxNodes && edgeCount < limits.maxEdges) {
    const current = frontier.shift()!;
    if (current.depth > limits.maxDepth) continue;

    for (const [key, edge] of graph.edges) {
      if (edge.strength < limits.minEdgeStrength) continue;
      const neighbor = edge.source === current.nodeId ? edge.target : edge.target === current.nodeId ? edge.source : null;
      if (!neighbor || current.path.includes(neighbor)) continue;

      if (!seenNodes.has(neighbor)) {
        seenNodes.add(neighbor);
        nodeCount += 1;
        allNodes.push({ id: neighbor, type: graph.nodes.get(neighbor)?.type ?? "WALLET", label: graph.nodes.get(neighbor)?.label ?? neighbor });
      }
      if (edgeCount < limits.maxEdges) {
        edgeCount += 1;
        allEdges.push({ source: edge.source, target: edge.target, type: edge.type, strength: edge.strength, confidence: edge.confidence });
      }

      const nextPath = [...current.path, neighbor];
      const strength = current.strength * edge.strength;
      const confidence = Math.min(current.confidence, edge.confidence);

      const neighborNode = graph.nodes.get(neighbor);
      if (neighborNode?.type === "ENTITY" || current.depth === limits.maxDepth - 1) {
        paths.push({
          id: `path-${nextPath.join("-")}`,
          analysisId: "",
          targetWalletId: targetAddress,
          rank: 0,
          pathType: "ATTRIBUTION",
          nodes: nextPath.map((id) => {
            const n = graph.nodes.get(id)!;
            return { id: n.id, type: n.type, label: n.label };
          }),
          edges: toEdges(nextPath),
          pathScore: strength,
          confidenceScore: confidence,
          summary: `Path from ${targetAddress} through ${nextPath.length - 1} hop(s).`,
          createdAt: new Date().toISOString(),
          engineVersion: GRAPH_ENGINE_VERSION
        });
      }

      frontier.push({ nodeId: neighbor, depth: current.depth + 1, path: nextPath, strength, confidence });
    }
  }

  paths.sort((a, b) => b.pathScore - a.pathScore);
  paths.forEach((p, i) => {
    p.rank = i + 1;
  });

  return { paths: paths.slice(0, 10), nodes: allNodes, edges: allEdges };
}

function toEdges(path: string[]): ExposurePathEdge[] {
  const edges: ExposurePathEdge[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    edges.push({
      source: path[i]!,
      target: path[i + 1]!,
      type: "TRANSFERRED",
      strength: 0,
      confidence: 0
    });
  }
  return edges;
}

export type { Confidence, ExposurePath, ExposurePathEdge, ExposurePathEdgeType, ExposurePathNode, ExposurePathNodeType, GraphLimits, WalletRelationship };
