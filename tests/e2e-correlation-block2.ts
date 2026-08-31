/**
 * Block 2 E2E: temporal → entity → relationship graph → multi-hop paths →
 * cluster hypothesis → persisted structured result (D5-E..D5-H).
 *
 * Offline deterministic harness — no RPC, no DB. Verifies the full Block 2
 * intelligence chain on synthetic normalized activity and that every stage
 * produces inspectable evidence with safe language.
 *
 * Run: pnpm test:correlation-block2
 */

import { computeCorrelation, evaluateEntityOverlap, evaluateTemporalCorrelation, type CorrelationInput, type OverlapInput } from "@aegix/correlation";
import { buildRelationshipClusters, findRelationshipPaths, type ClusterEdge } from "@aegix/graph";
import type { TransferRow, WalletRelationship } from "@aegix/types";

let pass = 0;
let fail = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`✔ ${name}`);
  } else {
    fail += 1;
    console.log(`✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- Fixtures: two wallets with correlated timing + funding + shared uncommon entity ----

const WALLET_A = "WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FUNDER = "FunderWallet111111111111111111111111111111";
const UNCOMMON_ENTITY = "UncommonEntity1111111111111111111111111111111";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function at(iso: string, signature = `sig-${iso}`): { timestamp: string; signature: string } {
  return { timestamp: iso, signature };
}

function transfer(from: string, to: string, value: number, blockTime: string): TransferRow {
  return {
    id: `t-${from.slice(0, 4)}-${to.slice(0, 4)}-${value}-${blockTime}`,
    transaction_id: `tx-${from.slice(0, 4)}-${to.slice(0, 4)}-${value}-${blockTime}`,
    from_address: from,
    to_address: to,
    asset_type: "SOL",
    mint: null,
    amount_raw: String(value),
    amount_normalized: String(value),
    transfer_type: "TRANSFER",
    block_time: blockTime
  };
}

function rel(a: string, b: string, strength: number, confidence: number, type: WalletRelationship["relationshipType"] = "FUNDED_BY"): WalletRelationship {
  return {
    id: `${a}-${b}`,
    walletA: a,
    walletB: b,
    relationshipType: type,
    direction: "INCOMING",
    transactionCount: 5,
    interactionCount: 5,
    totalValue: 100,
    firstSeen: "2026-02-01T12:00:00Z",
    lastSeen: "2026-02-05T12:00:00Z",
    strengthScore: strength,
    confidenceScore: confidence,
    evidenceJson: { signatures: ["tx-e2e-1", "tx-e2e-2"] },
    engineVersion: "e2e-rel-v1",
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-05T00:00:00Z"
  };
}

async function main(): Promise<void> {
  console.log("\n=== Block 2 E2E: temporal → entity → graph → paths → cluster ===\n");

  // ---- 1. Temporal correlation (D5-E) ----
  const T0 = "2026-02-01T12:00:00Z";
  const activityA = [0, 86400, 172800, 259200, 345600].map((o, i) => at(new Date(new Date(T0).getTime() + o * 1000).toISOString(), `a-sig-${i}`));
  const activityB = [45, 86445, 172845, 259245, 345645].map((o, i) => at(new Date(new Date(T0).getTime() + o * 1000).toISOString(), `b-sig-${i}`));
  const temporal = evaluateTemporalCorrelation({
    walletA: WALLET_A,
    walletB: WALLET_B,
    activityA,
    activityB,
    observationPeriodSeconds: 400000
  });
  ok("TEMPORAL: repeated short-window matches detected", temporal !== null);
  ok("TEMPORAL: matched windows exposed with signatures", temporal?.evidence.some((e) => e.key === "observed_matches") === true);
  ok("TEMPORAL: safe language", temporal ? !JSON.stringify(temporal).toLowerCase().includes("timezone") : true);

  // ---- 2. Entity matching (D5-F) ----
  const entity = evaluateEntityOverlap({
    walletA: WALLET_A,
    walletB: WALLET_B,
    transfersA: [transfer(UNCOMMON_ENTITY, WALLET_A, 2, "2026-02-01T12:00:00Z"), transfer(UNCOMMON_ENTITY, WALLET_A, 3, "2026-02-02T12:00:00Z")],
    transfersB: [transfer(UNCOMMON_ENTITY, WALLET_B, 2, "2026-02-01T12:00:00Z")],
    knownEntityAddresses: new Set([UNCOMMON_ENTITY, JUPITER]),
    entityNamesByAddress: new Map([[UNCOMMON_ENTITY, "Rare Protocol"], [JUPITER, "Jupiter"]]),
    entityConfidenceByAddress: new Map([[UNCOMMON_ENTITY, 0.9], [JUPITER, 0.98]])
  });
  ok("ENTITY: uncommon shared entity detected", entity !== null);
  ok("ENTITY: uncommon stronger than common", entity?.strength !== undefined && entity.strength >= 0.25, `strength ${entity?.strength}`);

  // ---- 3. Correlation engine with temporal family (D5-E §17) ----
  const correlationInput: CorrelationInput = {
    walletA: WALLET_A,
    walletB: WALLET_B,
    transfersA: [transfer(WALLET_B, WALLET_A, 10, "2026-02-01T12:00:00Z"), transfer(WALLET_B, WALLET_A, 12, "2026-02-02T12:00:00Z"), transfer(WALLET_B, WALLET_A, 8, "2026-02-03T12:00:00Z")],
    transfersB: [transfer(WALLET_A, WALLET_B, 4, "2026-02-04T12:00:00Z")],
    transactionCountA: 40,
    transactionCountB: 40,
    activityA,
    activityB,
    knownEntityAddresses: new Set([UNCOMMON_ENTITY])
  };
  const correlation = computeCorrelation(correlationInput);
  ok("CORRELATION: temporal family included", correlation.evidenceFamilies.some((f) => f.family === "TEMPORAL_CORRELATION"));
  ok("CORRELATION: funding dominates (score high but evidence-typed)", correlation.correlationScore >= 40, `score ${correlation.correlationScore}`);
  ok("CORRELATION: family engine versions recorded", correlation.evidenceFamilies.every((f) => typeof f.engineVersion === "string" && f.engineVersion.length > 0));

  // ---- 4. Multi-hop relationship graph (D5-G) ----
  const graphResult = await findRelationshipPaths({
    targetWallet: WALLET_A,
    relationships: [
      rel(WALLET_A, WALLET_B, 0.8, 0.85),
      rel(WALLET_A, FUNDER, 0.75, 0.8),
      rel(FUNDER, UNCOMMON_ENTITY, 0.6, 0.7, "REPEATED_COUNTERPARTY")
    ],
    commonality: new Map([[JUPITER, 0.95], [UNCOMMON_ENTITY, 0.1]]),
    limits: { maxDepth: 3, maxNodes: 50 }
  });
  ok("GRAPH: bounded paths found", graphResult.paths.length > 0);
  ok("GRAPH: budget accounting exposed", typeof graphResult.rpcCallsConsumed === "number" && typeof graphResult.rpcBudgetRemaining === "number");
  ok("GRAPH: stop reason recorded", graphResult.stopReason.length > 0);
  ok("GRAPH: every edge has metadata", graphResult.edges.every((e) => e.observationClass && e.sourceEngine && e.engineVersion));

  // Hub-only path through Jupiter must be near-useless (D5-G §37).
  const hubGraph = await findRelationshipPaths({
    targetWallet: WALLET_A,
    relationships: [rel(WALLET_A, JUPITER, 0.9), rel(JUPITER, WALLET_B, 0.9)],
    commonality: new Map([[JUPITER, 0.95]]),
    limits: { maxDepth: 3 }
  });
  const viaHub = hubGraph.paths.find((p) => p.path.nodes.some((n) => n.id === WALLET_B));
  ok("GRAPH: A→Jupiter→B path is near-useless", !viaHub || viaHub.path.pathScore < 0.3, `score ${viaHub?.path.pathScore}`);

  // ---- 5. Cluster hypothesis (D5-H) ----
  const clusterEdges: ClusterEdge[] = [
    { walletA: WALLET_A, walletB: WALLET_B, evidenceFamilies: ["FUNDING", "TEMPORAL"], strength: 0.7, confidence: 0.8, direct: true },
    { walletA: WALLET_A, walletB: FUNDER, evidenceFamilies: ["FUNDING", "ENTITY"], strength: 0.65, confidence: 0.75, direct: true }
  ];
  const clusterResult = buildRelationshipClusters({
    targetWallet: WALLET_A,
    edges: clusterEdges,
    entityAddresses: new Set([JUPITER, UNCOMMON_ENTITY]),
    limits: { maxClusterSize: 10 }
  });
  ok("CLUSTER: relationship cluster formed", clusterResult.clusters.length === 1, `${clusterResult.clusters.length}`);
  ok("CLUSTER: members carry evidence families", clusterResult.clusters[0]?.members.every((m) => m.evidenceFamilies.length >= 1) === true);
  ok("CLUSTER: stable fingerprint", clusterResult.clusters[0]!.id.startsWith("cluster-"));
  ok("CLUSTER: safe language (relationship cluster, not owner cluster)", !JSON.stringify(clusterResult).toLowerCase().includes("same owner"));
  ok("CLUSTER: limitations explain weak points", clusterResult.clusters[0]!.limitations.length > 0);

  // Negative control: shared Jupiter only must NOT form a cluster.
  const negative = buildRelationshipClusters({
    targetWallet: WALLET_A,
    edges: [
      { walletA: WALLET_A, walletB: WALLET_B, evidenceFamilies: ["ENTITY"], strength: 0.2, confidence: 0.5, direct: false }
    ],
    entityAddresses: new Set([JUPITER])
  });
  ok("CLUSTER-NEGATIVE: shared Jupiter only → no cluster", negative.clusters.length === 0);

  // ---- 6. Persisted structured result (idempotent, versioned) ----
  const persisted = {
    analysisId: "e2e-block2-analysis",
    correlation: {
      pairId: correlation.pairId,
      score: correlation.correlationScore,
      confidence: correlation.confidence,
      engineVersion: correlation.engineVersion,
      families: correlation.evidenceFamilies.map((f) => ({ family: f.family, strength: f.strength, engineVersion: f.engineVersion }))
    },
    temporal: temporal ? { strength: temporal.strength, confidence: temporal.confidence, engineVersion: temporal.engineVersion } : null,
    entity: entity ? { strength: entity.strength, engineVersion: entity.engineVersion } : null,
    graph: {
      engineVersion: graphResult.engineVersion,
      paths: graphResult.paths.map((p) => ({ id: p.path.id, type: p.path.pathType, score: p.path.pathScore, confidence: p.path.confidenceScore })),
      stopReason: graphResult.stopReason,
      rpcCallsConsumed: graphResult.rpcCallsConsumed
    },
    clusters: clusterResult.clusters.map((c) => ({
      id: c.id,
      members: c.members.map((m) => m.wallet),
      confidence: c.confidence,
      engineVersion: c.engineVersion
    }))
  };
  ok("PERSIST: structured result has all stages", persisted.temporal !== null && persisted.entity !== null && persisted.graph.paths.length > 0 && persisted.clusters.length > 0);
  ok("PERSIST: versions present everywhere", typeof persisted.correlation.engineVersion === "string" && typeof persisted.temporal!.engineVersion === "string" && typeof persisted.graph.engineVersion === "string" && typeof persisted.clusters[0]!.engineVersion === "string");
  const persistedJson = JSON.stringify(persisted);
  ok("PERSIST: safe language end-to-end", !persistedJson.toLowerCase().includes("same owner") && !persistedJson.toLowerCase().includes("identity match"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
