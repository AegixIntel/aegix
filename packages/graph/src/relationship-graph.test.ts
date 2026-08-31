/**
 * D5-G multi-hop relationship graph tests, see docs/d5-block2.md.
 * Covers: direct funding path, 2-hop repeated funding, hub-only path
 * (near-useless), dust-assisted path, mixed observed/inferred path,
 * long weak path, budget exhaustion, path dedup (§49).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WalletRelationship } from "@aegix/types";
import { canonicalPathIdentity, classifyPathType, findRelationshipPaths } from "./relationship-graph.js";

function rel(a: string, b: string, strength: number, confidence = 0.8, type: WalletRelationship["relationshipType"] = "FUNDED_BY", evidence: unknown = ["sig-1"]): WalletRelationship {
  return {
    id: `${a}-${b}`,
    walletA: a,
    walletB: b,
    relationshipType: type,
    direction: "INCOMING",
    transactionCount: 5,
    interactionCount: 5,
    totalValue: 100,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-10T00:00:00Z",
    strengthScore: strength,
    confidenceScore: confidence,
    evidenceJson: evidence,
    engineVersion: "test-rel-v1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-10T00:00:00Z"
  };
}

const TARGET = "TargetWallet111111111111111111111111111111";
const FUNDER = "FunderWallet111111111111111111111111111111";
const GRAND = "GrandFunder1111111111111111111111111111111";
const HUB = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"; // Jupiter program id (known hub)
const FRIEND = "FriendWallet111111111111111111111111111111";

test("GRAPH: direct funding path is observed and ranked", async () => {
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: [rel(TARGET, FUNDER, 0.9)],
    limits: { maxDepth: 2 }
  });
  assert.ok(r.paths.length >= 1, "at least one path");
  const p = r.paths[0]!.path;
  assert.equal(p.pathType, "OBSERVED_PATH");
  assert.equal(p.edges.length, 1);
  assert.equal(p.edges[0]!.observationClass, "OBSERVED");
  assert.ok(p.edges[0]!.evidence.length > 0, "evidence references present");
  assert.ok(p.explanation.length > 0, "path explained");
});

test("GRAPH: 2-hop repeated funding path with bottleneck confidence", async () => {
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: [
      rel(TARGET, FUNDER, 0.85, 0.95),
      rel(FUNDER, GRAND, 0.75, 0.42) // weak link
    ],
    limits: { maxDepth: 3 }
  });
  const p = r.paths.find((x) => x.path.nodes.some((n) => n.id === GRAND))?.path;
  assert.ok(p, "2-hop path to grand funder found");
  assert.equal(p!.edges.length, 2);
  // Bottleneck confidence must reflect the weak 0.42 edge (D5-G §41).
  assert.ok(p!.confidenceScore <= 0.42, `confidence ${p!.confidenceScore} <= 0.42`);
});

test("GRAPH: hub-only path is heavily penalized (near-useless)", async () => {
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: [
      rel(TARGET, HUB, 0.9),
      rel(HUB, FRIEND, 0.9)
    ],
    commonality: new Map([[HUB, 0.95]]), // Jupiter-like hub
    limits: { maxDepth: 3 }
  });
  const viaHub = r.paths.find((x) => x.path.nodes.some((n) => n.id === FRIEND));
  if (viaHub) {
    // Even with two 0.9 edges, hub penalty (0.25) collapses the path.
    assert.ok(viaHub.path.pathScore < 0.3, `hub path score ${viaHub.path.pathScore}`);
  }
});

test("GRAPH: dust-assisted path stays weak", async () => {
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: [
      rel(TARGET, FUNDER, 0.9),
      rel(FUNDER, FRIEND, 0.12) // dust-level edge
    ],
    limits: { maxDepth: 3, minEdgeStrength: 0.1 }
  });
  const viaDust = r.paths.find((x) => x.path.nodes.some((n) => n.id === FRIEND));
  if (viaDust) {
    assert.ok(viaDust.path.pathScore < 0.3, `dust path score ${viaDust.path.pathScore}`);
  }
});

test("GRAPH: mixed observed/inferred path is MIXED_PATH", async () => {
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: [rel(TARGET, FUNDER, 0.8)],
    inferredEdges: [{
      walletA: FUNDER,
      walletB: FRIEND,
      type: "BEHAVIORALLY_CORRELATED",
      strength: 0.7,
      confidence: 0.6,
      evidence: ["behavior-feature-overlap"],
      sourceEngine: "behavioral-similarity",
      engineVersion: "behavioral-similarity-v1.0.0"
    }],
    limits: { maxDepth: 3 }
  });
  const p = r.paths.find((x) => x.path.nodes.some((n) => n.id === FRIEND))?.path;
  assert.ok(p, "mixed path found");
  assert.equal(p!.pathType, "MIXED_PATH");
  assert.ok(p!.edges.some((e) => e.observationClass === "INFERRED"));
  assert.ok(p!.explanation.some((x) => x.includes("Inferred")), "explanation mentions inference");
});

test("GRAPH: long weak path is penalized by depth + strength", async () => {
  const chain = [
    rel(TARGET, "W1", 0.5),
    rel("W1", "W2", 0.5),
    rel("W2", "W3", 0.5),
    rel("W3", "W4", 0.5)
  ];
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: chain,
    limits: { maxDepth: 5 }
  });
  const deep = r.paths.find((x) => x.path.nodes.length === 5);
  if (deep) {
    assert.ok(deep.path.confidenceScore < 0.6, `deep path confidence ${deep.path.confidenceScore}`);
  }
});

test("GRAPH: budget exhaustion stops expansion with reason", async () => {
  const relationships = Array.from({ length: 40 }, (_, i) => rel(TARGET, `CP${i}`, 0.5));
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships,
    fetchRelationships: async () => Array.from({ length: 30 }, (_, i) => rel("CP0", `X${i}`, 0.6)),
    limits: { maxDepth: 3, maxSecondaryRpcCalls: 2, maxSecondaryWallets: 2 }
  });
  assert.ok(r.secondaryWalletsFetched <= 2, `fetched ${r.secondaryWalletsFetched}`);
  assert.ok(r.rpcCallsConsumed <= 2, `rpc ${r.rpcCallsConsumed}`);
  assert.ok(r.rpcBudgetRemaining >= 0, "budget remaining exposed");
  assert.ok(r.stopReason === "RPC_BUDGET" || r.stopReason === "MAX_NODES" || r.stopReason === "MAX_EDGES", `stop reason ${r.stopReason}`);
});

test("GRAPH: path dedup — reorder-insensitive identity", async () => {
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: [rel(TARGET, FUNDER, 0.8)],
    inferredEdges: [
      { walletA: FUNDER, walletB: FRIEND, type: "SHARED_COUNTERPARTY", strength: 0.6, confidence: 0.5, evidence: [], sourceEngine: "x", engineVersion: "x" }
    ],
    limits: { maxDepth: 3 }
  });
  const ids = r.paths.map((p) => p.identity);
  assert.equal(new Set(ids).size, ids.length, "no duplicate path identities");
});

test("GRAPH: identity is reorder-insensitive (A→B == B→A)", () => {
  const id1 = canonicalPathIdentity(["A", "B", "C"], [
    { source: "A", target: "B", type: "FUNDED", strength: 1, confidence: 1, observationClass: "OBSERVED", evidence: [], sourceEngine: "t", engineVersion: "t" },
    { source: "B", target: "C", type: "FUNDED", strength: 1, confidence: 1, observationClass: "OBSERVED", evidence: [], sourceEngine: "t", engineVersion: "t" }
  ]);
  const id2 = canonicalPathIdentity(["C", "B", "A"], [
    { source: "B", target: "A", type: "FUNDED", strength: 1, confidence: 1, observationClass: "OBSERVED", evidence: [], sourceEngine: "t", engineVersion: "t" },
    { source: "C", target: "B", type: "FUNDED", strength: 1, confidence: 1, observationClass: "OBSERVED", evidence: [], sourceEngine: "t", engineVersion: "t" }
  ]);
  assert.equal(id1, id2);
});

test("GRAPH: classifyPathType distinguishes observed/inferred/mixed", () => {
  const edge = (observationClass: "OBSERVED" | "INFERRED") => ({
    source: "A", target: "B", type: "FUNDED" as const, strength: 0.5, confidence: 0.5,
    observationClass, evidence: [], sourceEngine: "t", engineVersion: "t"
  });
  assert.equal(classifyPathType([edge("OBSERVED"), edge("OBSERVED")]), "OBSERVED_PATH");
  assert.equal(classifyPathType([edge("INFERRED"), edge("INFERRED")]), "INFERRED_PATH");
  assert.equal(classifyPathType([edge("OBSERVED"), edge("INFERRED")]), "MIXED_PATH");
});

test("GRAPH: safe language — never ownership claims", async () => {
  const r = await findRelationshipPaths({
    targetWallet: TARGET,
    relationships: [rel(TARGET, FUNDER, 0.8), rel(FUNDER, GRAND, 0.7)],
    limits: { maxDepth: 3 }
  });
  const text = JSON.stringify(r).toLowerCase();
  assert.ok(!text.includes("same owner"));
  assert.ok(!text.includes("owned by same"));
  assert.ok(!text.includes("identity match"));
});
