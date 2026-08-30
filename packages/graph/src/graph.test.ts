import assert from "node:assert/strict";
import { test } from "node:test";
import type { WalletRelationship } from "@aegix/types";
import { annotateEntities, buildGraph, findExposurePaths } from "./graph.js";
import { relationshipStrength } from "./path-scoring.js";

function rel(a: string, b: string, strength: number, confidence = 0.8): WalletRelationship {
  return {
    id: `${a}-${b}`,
    walletA: a,
    walletB: b,
    relationshipType: "FUNDED_BY",
    direction: "INCOMING",
    transactionCount: 5,
    interactionCount: 5,
    totalValue: 100,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-10T00:00:00Z",
    strengthScore: strength,
    confidenceScore: confidence,
    evidenceJson: {},
    engineVersion: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-10T00:00:00Z"
  };
}

test("builds graph from relationships", () => {
  const graph = buildGraph([rel("walletA", "walletB", 0.8), rel("walletB", "walletC", 0.5)]);
  assert.equal(graph.nodes.size, 3);
  assert.equal(graph.edges.size, 2);
});

test("annotates entity nodes", () => {
  const graph = buildGraph([rel("walletA", "binance", 0.9)]);
  annotateEntities(graph, [{ address: "binance", entityName: "Binance" }]);
  const node = graph.nodes.get("binance")!;
  assert.equal(node.type, "ENTITY");
  assert.equal(node.label, "Binance");
});

test("finds exposure paths with ranking", () => {
  const graph = buildGraph([
    rel("target", "funder", 0.9),
    rel("funder", "exchange", 0.7),
    rel("target", "friend", 0.4)
  ]);
  annotateEntities(graph, [{ address: "exchange", entityName: "Exchange" }]);

  const result = findExposurePaths({ targetAddress: "target", graph });

  assert.ok(result.paths.length >= 1);
  assert.equal(result.paths[0]!.rank, 1);
  assert.ok(result.paths.some((p) => p.nodes.some((n) => n.type === "ENTITY")));
});

test("relationship strength combines factors", () => {
  const strong = relationshipStrength({ transactionCount: 20, daysSinceLastSeen: 2, totalValue: 100, maxTotalValue: 100, counterpartyCount: 3, bidirectional: true });
  const weak = relationshipStrength({ transactionCount: 1, daysSinceLastSeen: 200, totalValue: 1, maxTotalValue: 100, counterpartyCount: 50, bidirectional: false });
  assert.ok(strong > weak);
  assert.ok(strong <= 1);
});
