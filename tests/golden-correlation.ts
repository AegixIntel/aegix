/**
 * Golden correlation regression suite, see docs/milestone-d5.md (D5-A §5).
 *
 * Offline deterministic harness: builds synthetic wallet-pair fixtures
 * (transfers, interactions, behavioral features), runs the correlation
 * engine, and asserts INVARIANTS — never ownership. Covers positive-ish
 * correlation cases and negative/control cases.
 *
 * Run: pnpm test:correlation
 */

import { computeCorrelation, evaluateBehavioralSimilarity, sampleAdequacy, traceFundingProvenance, type CorrelationInput } from "@aegix/correlation";
import type { TransferRow } from "@aegix/database";

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

// ---- Fixture helpers ----

let txId = 0;
function transfer(from: string, to: string, value: number, blockTime = "2026-01-01T00:00:00Z"): TransferRow {
  txId += 1;
  return {
    id: String(txId),
    transaction_id: `golden-sig-${txId}`,
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

const A = "WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "WalletCcccccccccccccccccccccccccccccccccccc";
const D = "WalletDdddddddddddddddddddddddddddddddddddd";
const X = "WalletXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const Y = "WalletYyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
const EXCHANGE = "ExchangeEeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const JUPITER_PROG = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RAYDIUM_PROG = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6";

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

function features(hourDist: Record<string, number>, protocolDist: Record<string, number>) {
  return [
    { feature_name: "activityHourDistribution", feature_value_json: hourDist },
    { feature_name: "weekdayDistribution", feature_value_json: { "1": 10 } },
    { feature_name: "protocolDistribution", feature_value_json: protocolDist }
  ];
}

// ---- Golden cases ----

async function main(): Promise<void> {
console.log("\n=== Golden correlation cases ===\n");

// 1. STRONG_FUNDING_CORRELATION
{
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8), transfer(B, A, 15), transfer(B, A, 20)];
  const r = computeCorrelation(baseInput({ transfersA }));
  ok("STRONG_FUNDING_CORRELATION: score >= 70", r.correlationScore >= 70, `score ${r.correlationScore}`);
  ok("STRONG_FUNDING_CORRELATION: funding family present", r.evidenceFamilies.some((f) => f.family === "FUNDING"));
  ok("STRONG_FUNDING_CORRELATION: classification HIGH+", r.classification === "HIGH_CORRELATION" || r.classification === "VERY_HIGH_CORRELATION", r.classification);
}

// 2. REPEATED_BIDIRECTIONAL_TRANSFER
{
  const transfersA = [transfer(B, A, 5), transfer(B, A, 6), transfer(A, B, 4), transfer(A, B, 7)];
  const transfersB = [transfer(A, B, 5), transfer(A, B, 6), transfer(B, A, 4), transfer(B, A, 7)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  const family = r.evidenceFamilies.find((f) => f.family === "TRANSFER_RELATIONSHIP");
  ok("REPEATED_BIDIRECTIONAL_TRANSFER: transfer family present", family !== undefined);
  ok("REPEATED_BIDIRECTIONAL_TRANSFER: score moderate+", r.correlationScore >= 40, `score ${r.correlationScore}`);
}

// 3. SHARED_COUNTERPARTY_ONLY
{
  const transfersA = [transfer(X, A, 1), transfer(X, A, 2), transfer(Y, A, 1)];
  const transfersB = [transfer(X, B, 1), transfer(X, B, 3), transfer(Y, B, 2)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  const family = r.evidenceFamilies.find((f) => f.family === "COUNTERPARTY_OVERLAP");
  ok("SHARED_COUNTERPARTY_ONLY: family present", family !== undefined);
  ok("SHARED_COUNTERPARTY_ONLY: not HIGH alone", r.correlationScore < 60, `score ${r.correlationScore}`);
}

// 4. MULTIPLE_SIGNAL_CORRELATION (funding + behavior + shared counterparty)
{
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8), transfer(X, A, 2)];
  const transfersB = [transfer(A, B, 10), transfer(A, B, 12), transfer(A, B, 8), transfer(X, B, 3)];
  const r = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    featuresA: features({ "10": 8, "11": 6 }, { "Drift": 7 }),
    featuresB: features({ "10": 9, "11": 5 }, { "Drift": 8 })
  }));
  const fundingOnly = computeCorrelation(baseInput({ transfersA: [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8)] }));
  ok("MULTIPLE_SIGNAL: >= 3 families", r.evidenceFamilies.length >= 3, `${r.evidenceFamilies.length}`);
  ok("MULTIPLE_SIGNAL: score >= 55", r.correlationScore >= 55, `score ${r.correlationScore}`);
  ok("MULTIPLE_SIGNAL: stronger than funding alone", r.correlationScore > fundingOnly.correlationScore, `${r.correlationScore} vs ${fundingOnly.correlationScore}`);
  ok("MULTIPLE_SIGNAL: confidence >= 0.6", r.confidence >= 0.6, `confidence ${r.confidence}`);
}

// 5. ENTITY_OVERLAP
{
  const transfersA = [transfer(EXCHANGE, A, 1)];
  const transfersB = [transfer(EXCHANGE, B, 1)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB, knownEntityAddresses: new Set([EXCHANGE]) }));
  const family = r.evidenceFamilies.find((f) => f.family === "ENTITY_OVERLAP");
  ok("ENTITY_OVERLAP: family present", family !== undefined);
  ok("ENTITY_OVERLAP: not strong alone", r.correlationScore < 55, `score ${r.correlationScore}`);
}

// 6. SHARED_PROTOCOL_ONLY (negative control)
{
  const interactionsA = [{ program_id: JUPITER_PROG, program_label: "Jupiter" }, { program_id: RAYDIUM_PROG, program_label: "Raydium" }];
  const interactionsB = [{ program_id: JUPITER_PROG, program_label: "Jupiter" }, { program_id: RAYDIUM_PROG, program_label: "Raydium" }];
  const r = computeCorrelation(baseInput({ interactionsA, interactionsB }));
  ok("SHARED_PROTOCOL_ONLY: no protocol family (common excluded)", !r.evidenceFamilies.some((f) => f.family === "PROTOCOL_SEQUENCE_SIMILARITY"));
  ok("SHARED_PROTOCOL_ONLY: score < 35", r.correlationScore < 35, `score ${r.correlationScore}`);
}

// 7. TEMPORAL_SIMILARITY_ONLY (negative control — one coincidence)
{
  const r = computeCorrelation(baseInput({ transactionCountA: 50, transactionCountB: 50 }));
  ok("TEMPORAL_SIMILARITY_ONLY: no temporal family (not implemented yet, score low)", r.correlationScore < 30, `score ${r.correlationScore}`);
}

// 8. WEAK_COINCIDENCE (single small transfer)
{
  const transfersA = [transfer(B, A, 0.5)];
  const r = computeCorrelation(baseInput({ transfersA }));
  ok("WEAK_COINCIDENCE: score < 40", r.correlationScore < 40, `score ${r.correlationScore}`);
  ok("WEAK_COINCIDENCE: not HIGH", r.classification !== "HIGH_CORRELATION" && r.classification !== "VERY_HIGH_CORRELATION", r.classification);
}

// 9. CLEARLY_UNRELATED (negative control)
{
  const transfersA = [transfer(X, A, 5)];
  const transfersB = [transfer(Y, B, 7)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  ok("CLEARLY_UNRELATED: score < 20", r.correlationScore < 20, `score ${r.correlationScore}`);
  ok("CLEARLY_UNRELATED: classification VERY_LOW/LOW", r.classification === "VERY_LOW_CORRELATION" || r.classification === "LOW_CORRELATION", r.classification);
}

// 10. INSUFFICIENT_DATA
{
  const transfersA = [transfer(B, A, 10)];
  const r = computeCorrelation(baseInput({ transfersA, transactionCountA: 1, transactionCountB: 1 }));
  ok("INSUFFICIENT_DATA: confidence <= 0.5", r.confidence <= 0.5, `confidence ${r.confidence}`);
  ok("INSUFFICIENT_DATA: limitation about sample", r.limitations.some((l) => l.includes("insufficient") || l.includes("sample")), r.limitations[0] ?? "");
}

// 11. LOW_SEMANTIC_COVERAGE
{
  const r = computeCorrelation(baseInput({
    featuresA: features({ "10": 8 }, { "Drift": 7 }),
    featuresB: features({ "10": 9 }, { "Drift": 8 }),
    semanticCoverageA: 0.2,
    semanticCoverageB: 0.2
  }));
  const behavior = r.evidenceFamilies.find((f) => f.family === "BEHAVIORAL_SIMILARITY");
  if (behavior) {
    ok("LOW_SEMANTIC_COVERAGE: behavior confidence capped", behavior.confidence <= 0.5, `confidence ${behavior.confidence}`);
  } else {
    ok("LOW_SEMANTIC_COVERAGE: behavior family absent or capped", true);
  }
}

// 12. DUST_ATTACK (negative control)
{
  const transfersA = [transfer(B, A, 0.0001), transfer(B, A, 0.0002), transfer(B, A, 0.0001)];
  const transfersB = [transfer(A, B, 0.0002), transfer(A, B, 0.0001)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  ok("DUST_ATTACK: score < 40", r.correlationScore < 40, `score ${r.correlationScore}`);
  ok("DUST_ATTACK: no funding family", !r.evidenceFamilies.some((f) => f.family === "FUNDING"));
}

// 13. HIGH_VOLUME_RANDOM (negative control — shared popular hubs, no real link)
{
  // 10 hub addresses, each appearing 20x in both wallets — like popular
  // exchange hot wallets or common protocol routers.
  const hubAddresses = Array.from({ length: 10 }, (_, i) => `Hub${i}${"h".repeat(39)}`.slice(0, 44));
  const transfersA = hubAddresses.flatMap((hub, i) =>
    Array.from({ length: 20 }, (_, j) => transfer(hub, A, 0.1 + i * 0.01, `2026-01-${String((j % 28) + 1).padStart(2, "0")}T00:00:00Z`))
  );
  const transfersB = hubAddresses.flatMap((hub, i) =>
    Array.from({ length: 20 }, (_, j) => transfer(hub, B, 0.1 + i * 0.02, `2026-01-${String((j % 28) + 1).padStart(2, "0")}T00:00:00Z`))
  );
  const r = computeCorrelation(baseInput({ transfersA, transfersB, transactionCountA: 200, transactionCountB: 200 }));
  ok("HIGH_VOLUME_RANDOM: shared hubs do not create HIGH", r.correlationScore < 60, `score ${r.correlationScore}`);
  ok("HIGH_VOLUME_RANDOM: no counterparty family (hub penalty)", !r.evidenceFamilies.some((f) => f.family === "COUNTERPARTY_OVERLAP"));
}

// 14. FUNDING_PROVENANCE entity terminus
{
  const paths = await traceFundingProvenance({
    targetWallet: A,
    targetTransfers: [transfer(X, A, 10), transfer(X, A, 12)],
    fetchTransfers: async () => [transfer(EXCHANGE, X, 50)],
    knownEntities: new Map([[EXCHANGE, "Verified Exchange"]])
  });
  const entityPath = paths.find((p) => p.terminusType === "ENTITY");
  ok("PROVENANCE: path to verified entity found", entityPath !== undefined);
  ok("PROVENANCE: safe language (no 'user identified')", !JSON.stringify(entityPath).toLowerCase().includes("user identified"));
}

// 15. BEHAVIORAL sample adequacy
{
  ok("SAMPLE: 3 txs marginal", sampleAdequacy(3) === "MARGINAL");
  ok("SAMPLE: 30 txs adequate", sampleAdequacy(30) === "ADEQUATE");
}

// ---- Cleanup ----

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
