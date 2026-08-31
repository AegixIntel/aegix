import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCorrelation, evaluateBehavioralSimilarity, evaluateFundingFamily, sampleAdequacy, traceFundingProvenance, type CorrelationInput } from "./index.js";
import type { TransferRow } from "@aegix/database";

// ---- Fixture builders ----

let txId = 0;
function transfer(from: string, to: string, value: number, blockTime = "2026-01-01T00:00:00Z", assetType = "SOL"): TransferRow {
  txId += 1;
  return {
    id: String(txId),
    transaction_id: `sig-${txId}`,
    from_address: from,
    to_address: to,
    asset_type: assetType,
    mint: null,
    amount_raw: String(value),
    amount_normalized: String(value),
    transfer_type: "TRANSFER",
    block_time: blockTime
  };
}

const A = "WalletA1111111111111111111111111111111111111";
const B = "WalletB2222222222222222222222222222222222222";
const X = "WalletX3333333333333333333333333333333333333";
const HUB = "Jup4r11111111111111111111111111111111111111";
const EXCHANGE = "Exchange5555555555555555555555555555555555";

function baseInput(overrides: Partial<CorrelationInput>): CorrelationInput {
  return {
    walletA: A,
    walletB: B,
    transfersA: [],
    transfersB: [],
    transactionCountA: 50,
    transactionCountB: 50,
    ...overrides
  };
}

// ---- Core scoring ----

test("STRONG_FUNDING: repeated direct funding produces high correlation", () => {
  const transfersA = [
    transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8), transfer(B, A, 15), transfer(B, A, 20)
  ];
  const result = computeCorrelation(baseInput({ transfersA }));
  assert.ok(result.correlationScore >= 70, `score ${result.correlationScore}`);
  assert.ok(result.evidenceFamilies.some((f) => f.family === "FUNDING"), "funding family present");
  assert.ok(result.confidence >= 0.6, `confidence ${result.confidence}`);
  assert.ok(result.classification === "HIGH_CORRELATION" || result.classification === "VERY_HIGH_CORRELATION");
});

test("SHARED_PROTOCOL_ONLY: shared Jupiter usage alone stays weak", () => {
  const interactionsA = [{ program_id: "JUP6", program_label: "Jupiter" }];
  const interactionsB = [{ program_id: "JUP6", program_label: "Jupiter" }];
  const result = computeCorrelation(baseInput({ interactionsA, interactionsB }));
  const protocolFamily = result.evidenceFamilies.find((f) => f.family === "PROTOCOL_SEQUENCE_SIMILARITY");
  assert.ok(protocolFamily === undefined, "common protocol alone must not create a family");
  assert.ok(result.correlationScore < 35, `score ${result.correlationScore}`);
});

test("DUST_ATTACK: dust transfers do not create strong correlation", () => {
  const transfersA = [transfer(B, A, 0.0001), transfer(B, A, 0.0002), transfer(B, A, 0.0001), transfer(B, A, 0.0003)];
  const transfersB = [transfer(A, B, 0.0002), transfer(A, B, 0.0001)];
  const result = computeCorrelation(baseInput({ transfersA, transfersB }));
  assert.ok(result.correlationScore < 40, `score ${result.correlationScore}`);
  const funding = result.evidenceFamilies.find((f) => f.family === "FUNDING");
  assert.ok(funding === undefined, "dust-only flow must not produce funding family");
});

test("CLEARLY_UNRELATED: no overlap → very low score, low confidence", () => {
  const result = computeCorrelation(baseInput({
    transfersA: [transfer(X, A, 5)],
    transfersB: [transfer("WalletY99999999999999999999999999999999999", B, 7)]
  }));
  assert.ok(result.correlationScore < 20, `score ${result.correlationScore}`);
  assert.ok(result.classification === "VERY_LOW_CORRELATION" || result.classification === "LOW_CORRELATION");
  assert.ok(result.limitations.length > 0, "limitations present");
});

test("MULTI_SIGNAL: funding + behavior + temporal-style overlap raises confidence vs funding alone", () => {
  const fundingOnly = computeCorrelation(baseInput({
    transfersA: [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8)]
  }));
  const multi = computeCorrelation(baseInput({
    transfersA: [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8)],
    featuresA: [
      { feature_name: "activityHourDistribution", feature_value_json: { "10": 10, "11": 8 } },
      { feature_name: "weekdayDistribution", feature_value_json: { "1": 18 } },
      { feature_name: "protocolDistribution", feature_value_json: { "Drift": 9 } }
    ],
    featuresB: [
      { feature_name: "activityHourDistribution", feature_value_json: { "10": 12, "11": 9 } },
      { feature_name: "weekdayDistribution", feature_value_json: { "1": 21 } },
      { feature_name: "protocolDistribution", feature_value_json: { "Drift": 10 } }
    ]
  }));
  assert.ok(multi.confidence > fundingOnly.confidence, `multi ${multi.confidence} vs funding-only ${fundingOnly.confidence}`);
  assert.ok(multi.evidenceFamilies.length > fundingOnly.evidenceFamilies.length, "more families");
});

test("INSUFFICIENT_DATA: 1 transaction caps confidence and score", () => {
  const result = computeCorrelation(baseInput({
    transfersA: [transfer(B, A, 10)],
    transactionCountA: 1,
    transactionCountB: 1
  }));
  assert.ok(result.confidence <= 0.5, `confidence ${result.confidence}`);
});

test("LOW_SEMANTIC_COVERAGE: behavioral confidence is capped", () => {
  const result = computeCorrelation(baseInput({
    featuresA: [
      { feature_name: "activityHourDistribution", feature_value_json: { "10": 10 } },
      { feature_name: "protocolDistribution", feature_value_json: { "Drift": 5 } }
    ],
    featuresB: [
      { feature_name: "activityHourDistribution", feature_value_json: { "10": 11 } },
      { feature_name: "protocolDistribution", feature_value_json: { "Drift": 6 } }
    ],
    semanticCoverageA: 0.2,
    semanticCoverageB: 0.2
  }));
  const behavior = result.evidenceFamilies.find((f) => f.family === "BEHAVIORAL_SIMILARITY");
  if (behavior) {
    assert.ok(behavior.confidence <= 0.5, `behavior confidence ${behavior.confidence}`);
  }
});

test("ABLATION: removing funding family lowers score materially", () => {
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8), transfer(B, A, 15)];
  const full = computeCorrelation(baseInput({ transfersA }));
  const ablated = computeCorrelation(baseInput({
    transfersA,
    disabledFamilies: new Set(["FUNDING"])
  }));
  assert.ok(ablated.correlationScore < full.correlationScore - 15, `full ${full.correlationScore} vs ablated ${ablated.correlationScore}`);
});

test("PAIR_CANONICAL: A,B == B,A", () => {
  // Wallet A receives repeated funding from B — symmetric under swap.
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8)];
  const transfersB = [transfer(A, B, 10), transfer(A, B, 12), transfer(A, B, 8)];
  const r1 = computeCorrelation(baseInput({ walletA: A, walletB: B, transfersA, transfersB }));
  const r2 = computeCorrelation(baseInput({ walletA: B, walletB: A, transfersA: transfersB, transfersB: transfersA }));
  assert.equal(r1.pairId, r2.pairId);
  assert.equal(r1.correlationScore, r2.correlationScore);
});

test("SAFE_LANGUAGE: output never claims ownership", () => {
  const result = computeCorrelation(baseInput({ transfersA: [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8)] }));
  const text = JSON.stringify(result).toLowerCase();
  assert.ok(!text.includes("same owner"));
  assert.ok(!text.includes("belong to"));
  assert.ok(!text.includes("owned by"));
});

// ---- Funding family unit ----

test("FUNDING: dust-only flow excluded, meaningful flow counted", () => {
  const dust = evaluateFundingFamily({
    walletA: A,
    walletB: B,
    transfersA: [transfer(B, A, 0.0001), transfer(B, A, 0.0002)],
    transfersB: []
  });
  assert.equal(dust, null);

  const meaningful = evaluateFundingFamily({
    walletA: A,
    walletB: B,
    transfersA: [transfer(B, A, 5), transfer(B, A, 7)],
    transfersB: []
  });
  assert.ok(meaningful !== null);
  assert.ok(meaningful.strength >= 0.4);
});

// ---- Behavioral similarity ----

test("BEHAVIOR: 3 transactions → marginal confidence, never high", () => {
  const adequacy = sampleAdequacy(3);
  assert.equal(adequacy, "MARGINAL");
  const result = evaluateBehavioralSimilarity({
    walletA: A,
    walletB: B,
    featuresA: [{ feature_name: "activityHourDistribution", feature_value_json: { "10": 3 } }],
    featuresB: [{ feature_name: "activityHourDistribution", feature_value_json: { "10": 3 } }],
    transactionCountA: 3,
    transactionCountB: 3,
    semanticCoverageA: 0.9,
    semanticCoverageB: 0.9
  });
  assert.ok(result === null || result.confidence <= 0.5, `confidence ${result?.confidence}`);
});

test("BEHAVIOR: identical distributions score high similarity", () => {
  const result = evaluateBehavioralSimilarity({
    walletA: A,
    walletB: B,
    featuresA: [
      { feature_name: "activityHourDistribution", feature_value_json: { "10": 10, "11": 8 } },
      { feature_name: "weekdayDistribution", feature_value_json: { "1": 18 } },
      { feature_name: "protocolDistribution", feature_value_json: { "Drift": 9, "Jupiter": 2 } }
    ],
    featuresB: [
      { feature_name: "activityHourDistribution", feature_value_json: { "10": 10, "11": 8 } },
      { feature_name: "weekdayDistribution", feature_value_json: { "1": 18 } },
      { feature_name: "protocolDistribution", feature_value_json: { "Drift": 9, "Jupiter": 2 } }
    ],
    transactionCountA: 50,
    transactionCountB: 50,
    semanticCoverageA: 0.9,
    semanticCoverageB: 0.9
  });
  assert.ok(result !== null);
  assert.ok(result.strength >= 0.8, `strength ${result.strength}`);
  assert.ok(result.limitations.some((l) => l.includes("difference")), "differences reported (anti confirmation bias)");
});

// ---- Funding provenance (multi-hop) ----

test("PROVENANCE: 2-hop path with entity terminus, confidence decays", async () => {
  const paths = await traceFundingProvenance({
    targetWallet: A,
    targetTransfers: [transfer(X, A, 10), transfer(X, A, 12)],
    fetchTransfers: async () => [transfer(EXCHANGE, X, 50), transfer(EXCHANGE, X, 60)],
    knownEntities: new Map([[EXCHANGE, "Verified Exchange"]])
  });
  const twoHop = paths.find((p) => p.hops.length === 2);
  assert.ok(twoHop, "2-hop path exists");
  assert.equal(twoHop.terminusType, "ENTITY");
  assert.equal(twoHop.terminusEntityName, "Verified Exchange");
  assert.ok(twoHop.pathConfidence < twoHop.hops[0]!.confidence, "confidence decays with hops");
});

test("PROVENANCE: dust funders excluded", async () => {
  const paths = await traceFundingProvenance({
    targetWallet: A,
    targetTransfers: [transfer(X, A, 0.0001), transfer(X, A, 0.0002)],
    fetchTransfers: async () => []
  });
  assert.equal(paths.length, 0);
});
