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

test("direct transfers do not also feed the temporal family", () => {
  // Evidence independence (D5-B §11): FUNDING and TRANSFER_RELATIONSHIP are
  // built from the A↔B transfers. Those same transactions must not reappear as
  // TEMPORAL_CORRELATION, or one observation would be counted three times.
  const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const times = ["2026-02-01T12:00:00Z", "2026-02-02T12:00:00Z", "2026-02-03T12:00:00Z", "2026-02-04T12:00:00Z"];
  const direct = times.map((block_time, i) => ({
    id: `id-${i}`,
    transaction_id: `tx${i}`,
    from_address: A,
    to_address: B,
    asset_type: "SOL",
    mint: null,
    amount_raw: "5000000000",
    amount_normalized: "5",
    transfer_type: "TRANSFER",
    block_time
  }));
  const activity = direct.map((t) => ({ timestamp: t.block_time, signature: t.transaction_id }));

  const result = computeCorrelation({
    walletA: A,
    walletB: B,
    transfersA: direct,
    transfersB: direct,
    transactionCountA: 40,
    transactionCountB: 40,
    activityA: activity,
    activityB: activity
  });

  const families = result.evidenceFamilies.map((f) => f.family);
  assert.ok(families.includes("FUNDING"), "direct flow is funding evidence");
  assert.ok(
    !families.includes("TEMPORAL_CORRELATION"),
    `direct transfers must not double-count as timing evidence: ${families.join(", ")}`
  );
});

test("excluding direct transfers does not suppress unrelated temporal evidence", () => {
  // The exclusion must be targeted, not a blanket mute. Wallets that transact
  // directly AND also act coincidentally through third parties should still
  // produce temporal evidence from the third-party activity.
  const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const X = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const Y = "YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";
  let n = 0;
  const row = (from: string, to: string, value: number, block_time: string) => {
    n += 1;
    return {
      id: String(n), transaction_id: `sig-${n}`, from_address: from, to_address: to,
      asset_type: "SOL", mint: null, amount_raw: String(value), amount_normalized: String(value),
      transfer_type: "TRANSFER", block_time
    };
  };

  const direct = ["2026-03-01T09:00:00Z", "2026-03-02T09:00:00Z", "2026-03-03T09:00:00Z"].map((t) => row(B, A, 10, t));
  const soloA = ["2026-03-05T09:00:00Z", "2026-03-06T09:00:00Z", "2026-03-07T09:00:00Z"].map((t) => row(X, A, 3, t));
  const soloB = ["2026-03-05T09:00:40Z", "2026-03-06T09:00:40Z", "2026-03-07T09:00:40Z"].map((t) => row(Y, B, 3, t));

  const transfersA = [...direct, ...soloA];
  const transfersB = [...direct, ...soloB];
  const activity = (rows: typeof transfersA) => rows.map((t) => ({ timestamp: t.block_time, signature: t.transaction_id }));

  const result = computeCorrelation({
    walletA: A, walletB: B, transfersA, transfersB,
    transactionCountA: 40, transactionCountB: 40,
    activityA: activity(transfersA), activityB: activity(transfersB)
  });

  const families = result.evidenceFamilies.map((f) => f.family);
  assert.ok(families.includes("FUNDING"), families.join(", "));
  assert.ok(
    families.includes("TEMPORAL_CORRELATION"),
    `third-party coincident activity is independent evidence and must survive: ${families.join(", ")}`
  );

  // And the direct transfers must not be what produced it.
  const temporal = result.evidenceFamilies.find((f) => f.family === "TEMPORAL_CORRELATION")!;
  const directSignatures = new Set(direct.map((t) => t.transaction_id));
  const cited = JSON.stringify(temporal.evidence);
  for (const signature of directSignatures) {
    assert.ok(!cited.includes(signature), `${signature} is direct-transfer evidence and must not be cited as timing evidence`);
  }
});

test("no signature is cited by more than one evidence family", () => {
  const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  let n = 0;
  const row = (from: string, to: string, value: number, block_time: string) => {
    n += 1;
    return {
      id: String(n), transaction_id: `sig-${n}`, from_address: from, to_address: to,
      asset_type: "SOL", mint: null, amount_raw: String(value), amount_normalized: String(value),
      transfer_type: "TRANSFER", block_time
    };
  };
  // Bidirectional flow exercises FUNDING and TRANSFER_RELATIONSHIP together.
  const ab = ["2026-03-01T09:00:00Z", "2026-03-02T09:00:00Z", "2026-03-03T09:00:00Z"].map((t) => row(A, B, 8, t));
  const ba = ["2026-03-01T10:00:00Z", "2026-03-02T10:00:00Z", "2026-03-03T10:00:00Z"].map((t) => row(B, A, 9, t));
  const all = [...ab, ...ba];
  const activity = all.map((t) => ({ timestamp: t.block_time, signature: t.transaction_id }));

  const result = computeCorrelation({
    walletA: A, walletB: B, transfersA: all, transfersB: all,
    transactionCountA: 40, transactionCountB: 40, activityA: activity, activityB: activity
  });

  const owners = new Map<string, string[]>();
  for (const family of result.evidenceFamilies) {
    for (const match of JSON.stringify(family.evidence).matchAll(/sig-\d+/g)) {
      owners.set(match[0], [...(owners.get(match[0]) ?? []), family.family]);
    }
  }
  for (const [signature, families] of owners) {
    assert.equal(families.length, 1, `${signature} is cited by ${families.join(" + ")} — evidence families must be disjoint`);
  }
});
