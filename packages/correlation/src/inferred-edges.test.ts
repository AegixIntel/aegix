/**
 * D5-I inferred-edge admission tests: correlation results become
 * CORRELATED_WITH edges only when thresholds pass; strong direct exception;
 * symmetry/dedup; rejections recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { correlationResultsToInferredEdges, correlationToInferredEdge, type CorrelationRowLike } from "./inferred-edges.js";

const A = "WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function corr(overrides: Partial<CorrelationRowLike>): CorrelationRowLike {
  const base = {
    walletA: A,
    walletB: B,
    correlationScore: 75,
    confidence: 0.7,
    evidenceFamilies: [
      { family: "FUNDING", strength: 0.8, confidence: 0.9, engineVersion: "funding-family-v1.0.0" },
      { family: "TEMPORAL_CORRELATION", strength: 0.5, confidence: 0.6, engineVersion: "temporal-v1.0.0" }
    ],
    limitations: [],
    engineVersion: "correlation-v1.0.0",
    ...overrides
  };
  // pairId always derives from the effective wallet pair (canonical, sorted).
  return { ...base, pairId: [base.walletA, base.walletB].sort().join("|") };
}

test("INFERRED: strong multi-evidence correlation qualifies", () => {
  const outcome = correlationToInferredEdge(corr({}));
  assert.equal(outcome.rejected, null);
  assert.ok(outcome.edge, "edge produced");
  assert.equal(outcome.edge.type, "CORRELATED_WITH");
  assert.equal(outcome.edge.observationClass, "INFERRED");
  assert.ok(outcome.edge.evidence.some((e) => e.includes("correlation_result")), "correlation result referenced");
});

test("INFERRED: shared-Jupiter-style weak overlap is rejected", () => {
  const outcome = correlationToInferredEdge(corr({
    correlationScore: 30,
    evidenceFamilies: [{ family: "PROTOCOL_SEQUENCE_SIMILARITY", strength: 0.4, confidence: 0.5, engineVersion: "x" }]
  }));
  assert.ok(outcome.rejected, "rejected");
  assert.match(outcome.rejected!, /score|families/);
});

test("INFERRED: low confidence is rejected", () => {
  const outcome = correlationToInferredEdge(corr({ confidence: 0.3 }));
  assert.ok(outcome.rejected?.includes("confidence"));
});

test("INFERRED: strong direct exception — one direct family at high score", () => {
  const outcome = correlationToInferredEdge(corr({
    correlationScore: 80,
    evidenceFamilies: [{ family: "FUNDING", strength: 0.9, confidence: 0.9, engineVersion: "x" }]
  }));
  assert.equal(outcome.rejected, null, "strong direct funding qualifies with one family");
});

test("INFERRED: high score with only weak families does NOT qualify", () => {
  const outcome = correlationToInferredEdge(corr({
    correlationScore: 72,
    evidenceFamilies: [{ family: "PROTOCOL_SEQUENCE_SIMILARITY", strength: 0.6, confidence: 0.7, engineVersion: "x" }]
  }));
  assert.ok(outcome.rejected, "shared protocol alone never qualifies even at high score");
});

test("INFERRED: symmetric pairs deduplicate", () => {
  const { edges, rejections } = correlationResultsToInferredEdges([
    corr({ walletA: A, walletB: B }),
    corr({ walletA: B, walletB: A }) // same pair, reversed
  ]);
  assert.equal(edges.length, 1, "one edge per canonical pair");
  assert.equal(rejections.length, 0);
});

test("INFERRED: distinct pairs produce distinct edges", () => {
  const C = "WalletCcccccccccccccccccccccccccccccccccccc";
  const { edges } = correlationResultsToInferredEdges([
    corr({ walletA: A, walletB: B }),
    corr({ walletA: A, walletB: C, pairId: [A, C].sort().join("|") })
  ]);
  assert.equal(edges.length, 2);
});

test("INFERRED: rejections recorded with reasons", () => {
  const { edges, rejections } = correlationResultsToInferredEdges([
    corr({ walletA: A, walletB: B, correlationScore: 10 }),
    corr({ walletA: A, walletB: "WalletDdddddddddddddddddddddddddddddddddddd" })
  ]);
  assert.equal(edges.length, 1);
  assert.equal(rejections.length, 1);
  assert.ok(rejections[0]!.reason.includes("score"));
});
