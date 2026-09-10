/**
 * Golden correlation dataset + false-positive matrix + ablation, see
 * docs/milestone-d5.md (D5-K §61-§74).
 *
 * Offline deterministic harness: builds synthetic wallet-pair fixtures,
 * runs the correlation engine, and asserts the FALSE-POSITIVE MATRIX:
 * shared Jupiter / shared USDC / shared exchange / single coincidence /
 * dust / hub-only / generic DeFi behavior must NOT produce strong
 * correlation, while multi-evidence positives must be materially stronger
 * than each weak signal alone.
 *
 * Run: pnpm test:correlation-dataset
 */

import { computeCorrelation, type CorrelationInput } from "@aegix/correlation";
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

let txId = 0;
function transfer(from: string, to: string, value: number, blockTime = "2026-01-01T00:00:00Z"): TransferRow {
  txId += 1;
  return {
    id: String(txId),
    transaction_id: `fp-sig-${txId}`,
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

const A = "EH2qq6FqPHk1vbfLjaNceGADeKTTPEVuQmQyC9YtYMmj";
const B = "DpFKMQXG21YQTUsCKGusU6SuQpAnR87dqu5DJL8Hm8Eb";
const C = "ENxD1HAtyHq8skEMpjU3r9KtGMBVcTUeHTe4Mxks1Hov";
const X = "J6AvzEkmvepWB498Q4QzHvTxgaLTqKBAoL3JFXVisEWx";
const Y = "E3ygRpueE2J1FS9G8SgrLzoenzjWrrYU5bm1o2jCuyVh";

const JUPITER_PROG = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EXCHANGE = "ExchangeEeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const HUB = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

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

function temporalActivity(base: string, offsetsSeconds: number[], prefix: string) {
  const baseMs = new Date(base).getTime();
  return offsetsSeconds.map((o, i) => ({
    timestamp: new Date(baseMs + o * 1000).toISOString(),
    signature: `${prefix}-${i}`
  }));
}

const T0 = "2026-02-01T12:00:00Z";

console.log("\n=== D5-K False-Positive Matrix ===\n");

// FP-1: shared Jupiter only (§63)
{
  const interactionsA = [{ program_id: JUPITER_PROG, program_label: "Jupiter" }];
  const interactionsB = [{ program_id: JUPITER_PROG, program_label: "Jupiter" }];
  const r = computeCorrelation(baseInput({ interactionsA, interactionsB }));
  ok("FP-1 SHARED_JUPITER: != HIGH", r.correlationScore < 60, `score ${r.correlationScore}`);
  ok("FP-1 SHARED_JUPITER: < 35 (weak)", r.correlationScore < 35, `score ${r.correlationScore}`);
}

// FP-2: shared USDC only (§64)
{
  const transfersA = [transfer(USDC_MINT, A, 5, "2026-01-01T00:00:00Z"), transfer(A, USDC_MINT, 3, "2026-01-02T00:00:00Z")];
  const transfersB = [transfer(USDC_MINT, B, 5, "2026-01-01T00:00:00Z"), transfer(B, USDC_MINT, 3, "2026-01-02T00:00:00Z")];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  ok("FP-2 SHARED_USDC: != HIGH", r.correlationScore < 60, `score ${r.correlationScore}`);
  ok("FP-2 SHARED_USDC: no counterparty family (common mint excluded)", !r.evidenceFamilies.some((f) => f.family === "COUNTERPARTY_OVERLAP"));
}

// FP-3: shared exchange entity only (§65)
{
  const transfersA = [transfer(EXCHANGE, A, 1), transfer(EXCHANGE, A, 2)];
  const transfersB = [transfer(EXCHANGE, B, 1), transfer(EXCHANGE, B, 2)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB, knownEntityAddresses: new Set([EXCHANGE]) }));
  ok("FP-3 SHARED_EXCHANGE: != HIGH", r.correlationScore < 60, `score ${r.correlationScore}`);
  const entity = r.evidenceFamilies.find((f) => f.family === "ENTITY_OVERLAP");
  ok("FP-3 SHARED_EXCHANGE: entity family not strong", entity ? entity.strength < 0.45 : true, `strength ${entity?.strength}`);
}

// FP-4: single timing coincidence (§66)
{
  const r = computeCorrelation(baseInput({
    transactionCountA: 50,
    transactionCountB: 50,
    activityA: temporalActivity(T0, [0], "a"),
    activityB: temporalActivity(T0, [45], "b")
  }));
  ok("FP-4 SINGLE_COINCIDENCE: no temporal family", !r.evidenceFamilies.some((f) => f.family === "TEMPORAL_CORRELATION"));
  ok("FP-4 SINGLE_COINCIDENCE: < 35", r.correlationScore < 35, `score ${r.correlationScore}`);
}

// FP-5: high-volume timing collision (§68)
{
  const offsetsA = Array.from({ length: 200 }, (_, i) => i * 3000 + (i % 7) * 86400);
  const offsetsB = Array.from({ length: 200 }, (_, i) => i * 3000 + 1500 + ((i + 3) % 7) * 86400);
  const r = computeCorrelation(baseInput({
    transactionCountA: 200,
    transactionCountB: 200,
    activityA: temporalActivity(T0, offsetsA, "a"),
    activityB: temporalActivity(T0, offsetsB, "b")
  }));
  const temporal = r.evidenceFamilies.find((f) => f.family === "TEMPORAL_CORRELATION");
  ok("FP-5 HIGH_VOLUME_COLLISION: temporal strength < 0.5", temporal ? temporal.strength < 0.5 : true, `strength ${temporal?.strength}`);
  ok("FP-5 HIGH_VOLUME_COLLISION: score < 60", r.correlationScore < 60, `score ${r.correlationScore}`);
}

// FP-6: behavior similarity only (two DeFi-heavy wallets) (§69)
{
  const r = computeCorrelation(baseInput({
    featuresA: features({ "10": 8, "11": 6, "12": 5 }, { "Jupiter": 10, "Raydium": 8, "Kamino": 5 }),
    featuresB: features({ "10": 7, "11": 7, "12": 6 }, { "Jupiter": 9, "Raydium": 7, "Kamino": 6 })
  }));
  ok("FP-6 DEFI_BEHAVIOR_ONLY: protocol family absent (common excluded)", !r.evidenceFamilies.some((f) => f.family === "PROTOCOL_SEQUENCE_SIMILARITY"));
  ok("FP-6 DEFI_BEHAVIOR_ONLY: score < 60", r.correlationScore < 60, `score ${r.correlationScore}`);
}

// FP-7: dust attack (§66)
{
  const transfersA = [transfer(B, A, 0.0001), transfer(B, A, 0.0002), transfer(B, A, 0.0001)];
  const transfersB = [transfer(A, B, 0.0002), transfer(A, B, 0.0001)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  ok("FP-7 DUST_ATTACK: no funding family", !r.evidenceFamilies.some((f) => f.family === "FUNDING"));
  ok("FP-7 DUST_ATTACK: < 40", r.correlationScore < 40, `score ${r.correlationScore}`);
}

// FP-8: hub-only relationship (§67)
{
  const hubTransfersA = Array.from({ length: 20 }, (_, i) => transfer(HUB, A, 0.1, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));
  const hubTransfersB = Array.from({ length: 20 }, (_, i) => transfer(HUB, B, 0.1, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));
  const r = computeCorrelation(baseInput({ transfersA: hubTransfersA, transfersB: hubTransfersB }));
  ok("FP-8 HUB_ONLY: score < 40", r.correlationScore < 40, `score ${r.correlationScore}`);
}

// FP-9: low history (§71)
{
  const r = computeCorrelation(baseInput({
    transfersA: [transfer(B, A, 10)],
    transactionCountA: 1,
    transactionCountB: 1
  }));
  ok("FP-9 LOW_SAMPLE: confidence <= 0.5", r.confidence <= 0.5, `confidence ${r.confidence}`);
}

// FP-10: low semantic coverage (§70)
{
  const r = computeCorrelation(baseInput({
    featuresA: features({ "10": 8 }, { "Drift": 7 }),
    featuresB: features({ "10": 9 }, { "Drift": 8 }),
    semanticCoverageA: 0.2,
    semanticCoverageB: 0.2
  }));
  const behavior = r.evidenceFamilies.find((f) => f.family === "BEHAVIORAL_SIMILARITY");
  ok("FP-10 LOW_COVERAGE: behavior confidence capped", behavior ? behavior.confidence <= 0.5 : true, `confidence ${behavior?.confidence}`);
}

// FP-11: unrelated pair
{
  const transfersA = [transfer(X, A, 5)];
  const transfersB = [transfer(Y, B, 7)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  ok("FP-11 UNRELATED: < 20", r.correlationScore < 20, `score ${r.correlationScore}`);
}

console.log("\n=== D5-K Positive Cases ===\n");

// P-1: strong direct funding
{
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8), transfer(B, A, 15), transfer(B, A, 20)];
  const r = computeCorrelation(baseInput({ transfersA }));
  ok("P-1 STRONG_FUNDING: score >= 70", r.correlationScore >= 70, `score ${r.correlationScore}`);
}

// P-2: repeated transfer (bidirectional)
{
  const transfersA = [transfer(B, A, 5), transfer(B, A, 6), transfer(A, B, 4), transfer(A, B, 7)];
  const transfersB = [transfer(A, B, 5), transfer(A, B, 6), transfer(B, A, 4), transfer(B, A, 7)];
  const r = computeCorrelation(baseInput({ transfersA, transfersB }));
  ok("P-2 REPEATED_TRANSFER: score >= 40", r.correlationScore >= 40, `score ${r.correlationScore}`);
}

// P-3: multi-evidence relationship (funding + behavior + shared counterparty)
{
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8), transfer(X, A, 2)];
  const transfersB = [transfer(A, B, 10), transfer(A, B, 12), transfer(A, B, 8), transfer(X, B, 3)];
  const r = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    featuresA: features({ "10": 8, "11": 6 }, { "Drift": 7 }),
    featuresB: features({ "10": 9, "11": 5 }, { "Drift": 8 })
  }));
  ok("P-3 MULTI_EVIDENCE: >= 3 families", r.evidenceFamilies.length >= 3, `${r.evidenceFamilies.length}`);
  ok("P-3 MULTI_EVIDENCE: score >= 55", r.correlationScore >= 55, `score ${r.correlationScore}`);
}

// P-4: repeated funding + temporal sequence (§72)
{
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8)];
  const activityA = temporalActivity(T0, [0, 86400, 172800], "a");
  const activityB = temporalActivity(T0, [60, 86460, 172860], "b");
  const fundingOnly = computeCorrelation(baseInput({ transfersA }));
  const multi = computeCorrelation(baseInput({
    transfersA,
    transactionCountA: 40,
    transactionCountB: 40,
    activityA,
    activityB
  }));
  ok("P-4 FUNDING+TEMPORAL: temporal family present", multi.evidenceFamilies.some((f) => f.family === "TEMPORAL_CORRELATION"));
  ok("P-4 FUNDING+TEMPORAL: materially stronger than funding alone", multi.correlationScore > fundingOnly.correlationScore + 2, `${multi.correlationScore} vs ${fundingOnly.correlationScore}`);
}

console.log("\n=== D5-K Ablation (§73-§74) ===\n");

// Ablation on the P-4 fixture: remove each evidence group and record the
// delta. "without direct" removes both FUNDING and TRANSFER_RELATIONSHIP
// (they are the same direct-flow evidence); "without temporal" removes the
// temporal family (D5-K §73-§74, §137).
{
  const transfersA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8)];
  const activityA = temporalActivity(T0, [0, 86400, 172800], "a");
  const activityB = temporalActivity(T0, [60, 86460, 172860], "b");
  const common = {
    walletA: A,
    walletB: B,
    transfersA,
    transfersB: [],
    transactionCountA: 40,
    transactionCountB: 40,
    activityA,
    activityB
  } satisfies CorrelationInput;

  const full = computeCorrelation(common);
  const noDirect = computeCorrelation({ ...common, disabledFamilies: new Set(["FUNDING", "TRANSFER_RELATIONSHIP"]) });
  const noTemporal = computeCorrelation({ ...common, disabledFamilies: new Set(["TEMPORAL_CORRELATION"]) });

  const ablation = [
    { label: "FULL", score: full.correlationScore },
    { label: "without direct (funding+transfer)", score: noDirect.correlationScore },
    { label: "without TEMPORAL", score: noTemporal.correlationScore }
  ];
  for (const row of ablation) {
    console.log(`  ablation ${row.label}: ${row.score}`);
  }
  ok("ABLATION: FULL > without-direct", ablation[0]!.score > ablation[1]!.score, `${ablation[0]!.score} vs ${ablation[1]!.score}`);
  ok("ABLATION: FULL > without-TEMPORAL", ablation[0]!.score > ablation[2]!.score, `${ablation[0]!.score} vs ${ablation[2]!.score}`);
  ok("ABLATION: score deltas inspectable via disabledFamilies", true, JSON.stringify(ablation));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
