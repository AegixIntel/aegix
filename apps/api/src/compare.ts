/**
 * Wallet comparison service, see docs/milestone-d5.md (D5-I §19-§26).
 *
 * Loads the two wallets' persisted analyses (reusing fresh READY analyses —
 * never re-analyzing both), computes cross-wallet correlation from persisted
 * data, builds the bounded relationship graph + cluster context, and returns
 * a structured, evidence-backed comparison.
 *
 * Canonical pair identity (A,B) == (B,A) is used for the cache/dedup key;
 * directional evidence (funding direction) remains directional in the result.
 */

import type { Sql } from "@aegix/database";
import {
  createAnalysisJobRepo,
  createBehavioralFeatureRepo,
  createCorrelationRepo,
  createEntityRegistryRepo,
  createIntelligenceRepo,
  createRelationshipClusterRepo,
  createRelationshipRepo,
  createWalletAnalyticsRepo,
  createWalletRepo,
  type AnalysisJobRow
} from "@aegix/database";
import type { AppConfig } from "@aegix/config";
import { computeCorrelation, correlationResultsToInferredEdges, type CorrelationInput, type CorrelationResult } from "@aegix/correlation";
import { buildRelationshipClusters, findRelationshipPaths, type ClusterEdge, type RelationshipGraphResult } from "@aegix/graph";
import type { ExposurePathEdge, WalletRelationship } from "@aegix/types";

export const COMPARE_ENGINE_VERSION = "compare-v1.0.0";

export interface CompareContext {
  sql: Sql;
  config: AppConfig;
}

export interface CompareWalletInput {
  walletA: string;
  walletB: string;
}

export interface CompareResult {
  walletA: string;
  walletB: string;
  /** Canonical pair id (sorted addresses). */
  pairId: string;
  correlation: CorrelationResult;
  /** Fresh READY analyses used for each side. */
  analyses: {
    a: { wallet: string; analysisId: string; status: string } | null;
    b: { wallet: string; analysisId: string; status: string } | null;
  };
  /** Relationship paths within the bounded graph (D5-G). */
  relationshipPaths: RelationshipGraphResult["paths"];
  /** Cluster context (D5-H). */
  clusters: ReturnType<typeof buildRelationshipClusters>["clusters"];
  /** Data quality per wallet. */
  dataQuality: { a: Record<string, unknown> | null; b: Record<string, unknown> | null };
  limitations: string[];
  engineVersions: Record<string, string>;
}

/** Canonical pair identity: (A,B) == (B,A), D5-I §25. */
export function canonicalComparePair(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** Cache key for a comparison; symmetric so B vs A reuses A vs B (§25). */
export function compareCacheKey(pairId: string): string {
  return `compare-result:${pairId}`;
}

/** Lock key for concurrent identical comparisons (§26). */
export function compareLockKey(pairId: string): string {
  return `compare-lock:${pairId}`;
}

function transferRowLike(row: { from_address: string; to_address: string; transaction_id: string; amount_normalized: string; block_time: string; asset_type: string; mint: string | null; amount_raw: string; transfer_type: string }): {
  id: string; transaction_id: string; from_address: string; to_address: string; asset_type: string;
  mint: string | null; amount_raw: string; amount_normalized: string; transfer_type: string; block_time: string;
} {
  return {
    id: String(row.transaction_id),
    transaction_id: row.transaction_id,
    from_address: row.from_address,
    to_address: row.to_address,
    asset_type: row.asset_type,
    mint: row.mint,
    amount_raw: row.amount_raw,
    amount_normalized: row.amount_normalized,
    transfer_type: row.transfer_type,
    block_time: row.block_time
  };
}

function relationshipRowLike(row: {
  id: string | number; wallet_a: string; wallet_b: string; relationship_type: string; direction: string;
  transaction_count: number; interaction_count: number; total_value: string | number; first_seen: string;
  last_seen: string; strength_score: string | number; confidence_score: string | number; evidence_json: unknown;
  engine_version: string | null; created_at: string; updated_at: string;
}): WalletRelationship {
  return {
    id: String(row.id),
    walletA: row.wallet_a,
    walletB: row.wallet_b,
    relationshipType: row.relationship_type as WalletRelationship["relationshipType"],
    direction: row.direction as WalletRelationship["direction"],
    transactionCount: row.transaction_count,
    interactionCount: row.interaction_count,
    totalValue: Number(row.total_value),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    strengthScore: Number(row.strength_score),
    confidenceScore: Number(row.confidence_score),
    evidenceJson: row.evidence_json,
    engineVersion: row.engine_version ?? "unknown",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Loads the freshest READY analysis for a wallet (D5-I §20: reuse first).
 * Returns null when no fresh analysis exists.
 */
export async function loadFreshAnalysis(ctx: CompareContext, address: string): Promise<{ job: AnalysisJobRow; walletId: string } | null> {
  const { sql } = ctx;
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const wallet = await walletRepo.findByAddress("solana", address);
  if (!wallet) return null;
  const latest = await jobRepo.latestForWallet(wallet.id);
  if (!latest || latest.status !== "READY") return null;
  if (latest.fresh_until && new Date(latest.fresh_until) < new Date()) return null;
  return { job: latest, walletId: wallet.id };
}

/** Runs the comparison from persisted data. Does NOT trigger new analyses. */
export async function runComparison(ctx: CompareContext, input: CompareWalletInput): Promise<CompareResult> {
  const { sql, config } = ctx;
  const pairId = canonicalComparePair(input.walletA, input.walletB);

  const walletRepo = createWalletRepo(sql);
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const behaviorRepo = createBehavioralFeatureRepo(sql);
  const entityRepo = createEntityRegistryRepo(sql);
  const correlationRepo = createCorrelationRepo(sql);
  const relationshipRepo = createRelationshipRepo(sql);
  const clusterRepo = createRelationshipClusterRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);

  const [walletA, walletB] = await Promise.all([
    walletRepo.findByAddress("solana", input.walletA),
    walletRepo.findByAddress("solana", input.walletB)
  ]);
  if (!walletA || !walletB) {
    throw new Error("WALLET_NOT_ANALYZED");
  }

  // Reuse-first: both wallets must have fresh READY analyses (D5-I §20).
  const [freshA, freshB] = await Promise.all([
    loadFreshAnalysis(ctx, input.walletA),
    loadFreshAnalysis(ctx, input.walletB)
  ]);
  if (!freshA || !freshB) {
    throw new Error("ANALYSIS_REQUIRED");
  }

  // Load persisted inputs for the correlation engine (no RPC).
  const [transfersA, transfersB, featuresA, featuresB, entities, relationshipsA, relationshipsB] = await Promise.all([
    analyticsRepo.transfersForWallet(freshA.walletId, 5000),
    analyticsRepo.transfersForWallet(freshB.walletId, 5000),
    behaviorRepo.featuresForWallet(freshA.walletId),
    behaviorRepo.featuresForWallet(freshB.walletId),
    entityRepo.findAddressesByChain("solana"),
    relationshipRepo.listForWallet(input.walletA, 100),
    relationshipRepo.listForWallet(input.walletB, 100)
  ]);

  const entityAddresses = new Set(entities.filter((e) => e.status === "VERIFIED").map((e) => e.address));
  const entityNames = new Map(entities.filter((e) => e.status === "VERIFIED").map((e) => [e.address, e.label ?? e.address]));
  const entityConfidence = new Map(entities.filter((e) => e.status === "VERIFIED").map((e) => [e.address, Number(e.confidence)]));

  const txCountA = freshA.job.data_quality && typeof (freshA.job.data_quality as Record<string, unknown>).transactionsParsed === "number"
    ? Number((freshA.job.data_quality as Record<string, unknown>).transactionsParsed)
    : transfersA.length;
  const txCountB = freshB.job.data_quality && typeof (freshB.job.data_quality as Record<string, unknown>).transactionsParsed === "number"
    ? Number((freshB.job.data_quality as Record<string, unknown>).transactionsParsed)
    : transfersB.length;

  const coverageA = ((freshA.job.data_quality ?? {}) as Record<string, unknown>).semanticCoverage;
  const coverageB = ((freshB.job.data_quality ?? {}) as Record<string, unknown>).semanticCoverage;

  const correlationInput: CorrelationInput = {
    walletA: input.walletA,
    walletB: input.walletB,
    transfersA: transfersA.map(transferRowLike),
    transfersB: transfersB.map(transferRowLike),
    interactionsA: [],
    interactionsB: [],
    knownEntityAddresses: entityAddresses,
    featuresA: featuresA.map((f) => ({ feature_name: f.feature_name, feature_value_json: f.feature_value_json })),
    featuresB: featuresB.map((f) => ({ feature_name: f.feature_name, feature_value_json: f.feature_value_json })),
    transactionCountA: Math.max(txCountA, transfersA.length),
    transactionCountB: Math.max(txCountB, transfersB.length),
    semanticCoverageA: typeof coverageA === "number" ? coverageA / 100 : 1,
    semanticCoverageB: typeof coverageB === "number" ? coverageB / 100 : 1,
    // Temporal: derive timestamps from transfers (persisted, no RPC).
    activityA: transfersA.map((t) => ({ timestamp: t.block_time, signature: t.transaction_id })),
    activityB: transfersB.map((t) => ({ timestamp: t.block_time, signature: t.transaction_id }))
  };

  const correlation = computeCorrelation(correlationInput);

  // Build the bounded relationship graph with observed + inferred edges
  // (D5-I §5-§12). Inferred edges come from persisted correlation_results
  // that pass admission.
  const persistedCorrelations = await correlationRepo.listForWallet(input.walletA, config.MAX_CORRELATION_CANDIDATE_WALLETS);
  const inferred = correlationResultsToInferredEdges(
    persistedCorrelations.map((row) => ({
      walletA: row.wallet_a,
      walletB: row.wallet_b,
      correlationScore: row.correlation_score,
      confidence: Number(row.confidence),
      evidenceFamilies: ((row.evidence_families ?? []) as Array<{ family: string; strength: number; confidence: number; engineVersion: string }>).map((f) => ({
        family: f.family,
        strength: Number(f.strength),
        confidence: Number(f.confidence),
        engineVersion: f.engineVersion ?? "unknown"
      })),
      limitations: (row.limitations ?? []) as string[],
      engineVersion: row.engine_version,
      pairId: [row.wallet_a, row.wallet_b].sort().join("|")
    })),
    {
      minScore: config.MIN_INFERRED_EDGE_SCORE,
      minConfidence: config.MIN_INFERRED_EDGE_CONFIDENCE,
      minEvidenceFamilies: config.MIN_INFERRED_EDGE_EVIDENCE_FAMILIES,
      minSample: 0,
      minSemanticCoverage: 0,
      strongDirectScore: config.INFERRED_EDGE_STRONG_DIRECT_SCORE
    }
  );

  const graph = await findRelationshipPaths({
    targetWallet: input.walletA,
    relationships: [...relationshipsA.map(relationshipRowLike), ...relationshipsB.map(relationshipRowLike)],
    inferredEdges: inferred.edges.map((e) => ({
      walletA: e.source,
      walletB: e.target,
      type: e.type,
      strength: e.strength,
      confidence: e.confidence,
      evidence: e.evidence,
      sourceEngine: e.sourceEngine,
      engineVersion: e.engineVersion
    })),
    commonality: new Map([...entityNames.keys()].map((addr) => [addr, 0.9])),
    fetchRelationships: async (addr) => {
      const rows = await relationshipRepo.listForWallet(addr, config.MAX_SECONDARY_WALLETS * 2);
      return rows.map(relationshipRowLike);
    },
    limits: {
      maxDepth: config.GRAPH_MAX_DEPTH,
      maxNodes: config.GRAPH_MAX_NODES,
      maxEdges: config.GRAPH_MAX_EDGES,
      maxSecondaryWallets: config.MAX_SECONDARY_WALLETS,
      maxSecondaryRpcCalls: config.MAX_SECONDARY_RPC_CALLS,
      maxGraphTimeMs: config.GRAPH_MAX_TIME_MS
    }
  });

  // Cluster context: observed + inferred edges, entity exclusion, D5-H.
  const clusterEdges: ClusterEdge[] = [];
  for (const edge of graph.edges) {
    const direct = edge.type === "FUNDED" || edge.type === "TRANSFERRED" || edge.type === "RECEIVED_FROM";
    const families = edge.observationClass === "OBSERVED"
      ? [edge.type === "FUNDED" || edge.type === "RECEIVED_FROM" ? "FUNDING" : "TRANSFER"]
      : edge.type === "CORRELATED_WITH"
        ? (edge.evidence ?? []).filter((e) => /^[A-Z_]+:/.test(e)).map((e) => e.split(":")[0]!).filter((f) => f !== "correlation_result")
        : [edge.type];
    if (families.length === 0) continue;
    clusterEdges.push({ walletA: edge.source, walletB: edge.target, evidenceFamilies: [...new Set(families)], strength: edge.strength, confidence: edge.confidence, direct });
  }
  const clusterResult = buildRelationshipClusters({
    targetWallet: input.walletA,
    edges: clusterEdges,
    entityAddresses,
    limits: { maxClusterSize: config.CLUSTER_MAX_SIZE }
  });

  const limitations: string[] = [
    "Correlation indicates observable linkability. It does not establish common ownership or real-world identity.",
    ...(graph.stopReason === "MAX_NODES" || graph.stopReason === "MAX_EDGES" || graph.stopReason === "RPC_BUDGET" || graph.stopReason === "TIME_BUDGET" || graph.stopReason === "PATH_BUDGET"
      ? [`Relationship graph expansion stopped early (${graph.stopReason}) — paths reflect a bounded analysis scope.`]
      : []),
    ...clusterResult.clusters.flatMap((c) => c.limitations)
  ];

  return {
    walletA: input.walletA,
    walletB: input.walletB,
    pairId,
    correlation,
    analyses: {
      a: { wallet: input.walletA, analysisId: freshA.job.id, status: freshA.job.status },
      b: { wallet: input.walletB, analysisId: freshB.job.id, status: freshB.job.status }
    },
    relationshipPaths: graph.paths.slice(0, 10),
    clusters: clusterResult.clusters,
    dataQuality: {
      a: (freshA.job.data_quality ?? {}) as Record<string, unknown>,
      b: (freshB.job.data_quality ?? {}) as Record<string, unknown>
    },
    limitations: [...new Set(limitations)].slice(0, 8),
    engineVersions: {
      compare: COMPARE_ENGINE_VERSION,
      correlation: correlation.engineVersion,
      graph: graph.engineVersion,
      cluster: clusterResult.engineVersion,
      inferredEdge: "inferred-edge-v1.0.0"
    }
  };
}

/** Loads a previously computed comparison from the canonical cache key. */
export async function cachedComparison(ctx: CompareContext, pairId: string): Promise<CompareResult | null> {
  const cache = (await import("@aegix/cache")).createCache(ctx.config.REDIS_URL, ctx.config.REDIS_CACHE_DB);
  try {
    const hit = await cache.getJson<CompareResult>(compareCacheKey(pairId));
    return hit ?? null;
  } finally {
    await cache.close();
  }
}
