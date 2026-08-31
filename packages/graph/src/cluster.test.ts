/**
 * D5-H cluster hypothesis tests, see docs/d5-block2.md.
 * Covers: strong multi-evidence cluster, weak single-edge non-cluster,
 * bridge-edge separation, hub-only non-cluster, low-data member, size cap,
 * safe language (§66-§67, §81).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRelationshipClusters, type ClusterEdge } from "./cluster.js";

const TARGET = "TargetWallet111111111111111111111111111111";
const W1 = "WalletOne11111111111111111111111111111111";
const W2 = "WalletTwo11111111111111111111111111111111";
const W3 = "WalletThree111111111111111111111111111111";
const HUB = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function edge(a: string, b: string, overrides: Partial<ClusterEdge> = {}): ClusterEdge {
  return {
    walletA: a,
    walletB: b,
    evidenceFamilies: ["FUNDING", "TEMPORAL"],
    strength: 0.6,
    confidence: 0.7,
    direct: true,
    ...overrides
  };
}

test("CLUSTER: strong multi-evidence edges form a cluster", () => {
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [
      edge(TARGET, W1, { evidenceFamilies: ["FUNDING", "TEMPORAL"], strength: 0.7 }),
      edge(TARGET, W2, { evidenceFamilies: ["FUNDING", "BEHAVIORAL"], strength: 0.65 })
    ]
  });
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0]!.members.length, 2);
  assert.ok(r.clusters[0]!.confidence >= 0.3, `confidence ${r.clusters[0]!.confidence}`);
  assert.ok(r.clusters[0]!.evidenceFamilies.includes("FUNDING"));
});

test("CLUSTER: weak single-evidence edge does not form a cluster", () => {
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [
      edge(TARGET, W1, { evidenceFamilies: ["SHARED_ENTITY"], strength: 0.3, confidence: 0.3 })
    ]
  });
  assert.equal(r.clusters.length, 0, "no cluster from one weak shared protocol");
  assert.ok(r.rejectedEdges.length >= 1, "rejection recorded");
});

test("CLUSTER: shared Jupiter only never forms a cluster", () => {
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [
      edge(TARGET, W1, { evidenceFamilies: ["ENTITY"], strength: 0.2, confidence: 0.5 }),
      edge(TARGET, W2, { evidenceFamilies: ["ENTITY"], strength: 0.2, confidence: 0.5 })
    ]
  });
  assert.equal(r.clusters.length, 0);
});

test("CLUSTER: one weak bridge edge does not merge two strong clusters", () => {
  // TARGET strongly linked to W1; W1 weakly linked to W2. W2 must NOT join.
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [
      edge(TARGET, W1, { evidenceFamilies: ["FUNDING", "TEMPORAL"], strength: 0.8 }),
      edge(W1, W2, { evidenceFamilies: ["ENTITY"], strength: 0.3, confidence: 0.35 })
    ]
  });
  assert.equal(r.clusters[0]!.members.length, 1, "only W1 is a member");
  assert.ok(r.rejectedEdges.some((e) => e.walletB === W2), "bridge edge rejected");
});

test("CLUSTER: direct strong edge alone can admit (exceptionally strong direct)", () => {
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [
      edge(TARGET, W1, { evidenceFamilies: ["FUNDING"], strength: 0.9, confidence: 0.9 })
    ]
  });
  assert.equal(r.clusters.length, 1, "one exceptionally strong direct edge admits");
  assert.equal(r.clusters[0]!.members.length, 1);
});

test("CLUSTER: entity/hub nodes never become members", () => {
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [
      edge(TARGET, HUB, { evidenceFamilies: ["FUNDING", "TEMPORAL"], strength: 0.8, confidence: 0.8 })
    ],
    entityAddresses: new Set([HUB])
  });
  assert.equal(r.clusters[0]!.members.length, 0, "hub is not a member");
  assert.ok(r.clusters[0]!.limitations.some((l) => l.includes("Entity/protocol")), "limitation explains exclusion");
});

test("CLUSTER: low-data member confidence is capped", () => {
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [edge(TARGET, W1, { strength: 0.7, confidence: 0.8 })],
    dataQuality: new Map([[W1, 0.2]])
  });
  const member = r.clusters[0]!.members[0]!;
  assert.ok(member.lowData, "member flagged low-data");
  assert.ok(member.confidence < 0.5, `low-data confidence capped (${member.confidence})`);
  assert.ok(r.clusters[0]!.limitations.some((l) => l.includes("low-data")), "limitation mentions low data");
});

test("CLUSTER: size cap bounds members", () => {
  const edges = Array.from({ length: 30 }, (_, i) => edge(TARGET, `Member${String(i).padStart(2, "0")}`, { strength: 0.6 + (i % 3) * 0.1 }));
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges,
    limits: { maxClusterSize: 5 }
  });
  assert.ok(r.clusters[0]!.members.length <= 5, `members ${r.clusters[0]!.members.length} <= 5`);
});

test("CLUSTER: fingerprint is stable and deterministic", () => {
  const r1 = buildRelationshipClusters({ targetWallet: TARGET, edges: [edge(TARGET, W1, { strength: 0.7 })] });
  const r2 = buildRelationshipClusters({ targetWallet: TARGET, edges: [edge(TARGET, W1, { strength: 0.7 })] });
  assert.equal(r1.clusters[0]!.id, r2.clusters[0]!.id);
  assert.ok(r1.clusters[0]!.id.startsWith("cluster-"));
});

test("CLUSTER: safe language — never ownership claims", () => {
  const r = buildRelationshipClusters({
    targetWallet: TARGET,
    edges: [edge(TARGET, W1, { strength: 0.8 }), edge(TARGET, W2, { strength: 0.7 })]
  });
  const text = JSON.stringify(r).toLowerCase();
  assert.ok(!text.includes("same owner"));
  assert.ok(!text.includes("owned by same"));
  assert.ok(!text.includes("confirmed owner"));
  assert.ok(text.includes("linkability"), "uses observable linkability language");
});
