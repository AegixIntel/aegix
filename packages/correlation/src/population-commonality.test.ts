/**
 * Population-commonality correlation tests (D6-I2 §23-§26).
 *
 * Proves that when population frequencies are supplied:
 *  - known false positives (shared common hubs) stay weak or get weaker
 *    (never materially stronger) — static vs population comparison;
 *  - meaningful rare multi-evidence relationships are NOT crushed;
 *  - the engine ignores the population map when the population is too small
 *    (fallback to the D5 static treatment);
 *  - sample adequacy + versioned gating are honored.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCorrelation, type CorrelationInput } from "./index.js";
import type { TransferRow } from "@aegix/database";

let txId = 0;
function transfer(from: string, to: string, value: number, blockTime = "2026-01-01T00:00:00Z"): TransferRow {
  txId += 1;
  return {
    id: String(txId),
    transaction_id: `pop-sig-${txId}`,
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
const RARE_CP = "J6AvzEkmvepWB498Q4QzHvTxgaLTqKBAoL3JFXVisEWx";
const COMMON_CP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const UNCOMMON_ENTITY = "6zqwqqE7CzJqaMxdLuE6VxtYVh1U4FTeUiEYVsSzgtG2";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

/** Shared counterparty on both sides (one transfer each side). */
function sharedCp(addr: string, count = 3): { transfersA: TransferRow[]; transfersB: TransferRow[] } {
  const transfersA = Array.from({ length: count }, (_, i) => transfer(addr, A, 0.1 + i, `2026-01-0${i + 1}T00:00:00Z`));
  const transfersB = Array.from({ length: count }, (_, i) => transfer(addr, B, 0.1 + i, `2026-01-0${i + 1}T00:00:00Z`));
  return { transfersA, transfersB };
}

test("FP: shared COMMON counterparty with high population frequency is discounted vs static", () => {
  const { transfersA, transfersB } = sharedCp(COMMON_CP, 1);
  const staticRun = computeCorrelation(baseInput({ transfersA, transfersB }));
  const populationRun = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    commonalityByAddress: new Map([[COMMON_CP, 0.68]]),
    commonalityMinPopulation: 20,
    populationSize: 200
  }));

  // Population-aware penalty must not make the shared-hub case stronger.
  assert.ok(populationRun.correlationScore <= staticRun.correlationScore + 1,
    `population ${populationRun.correlationScore} vs static ${staticRun.correlationScore}`);
  // And it stays weak (known negative preserved).
  assert.ok(populationRun.correlationScore < 35, `score ${populationRun.correlationScore}`);
});

test("FP: shared RARE counterparty stays MEANINGFUL under population commonality", () => {
  // A rare address each wallet touches exactly ONCE is the distinctive case:
  // repetition against a common hub is already penalized by the global
  // rarity heuristic, independent of population data.
  const { transfersA, transfersB } = sharedCp(RARE_CP, 1);
  const populationRun = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    commonalityByAddress: new Map([[RARE_CP, 0.004]]),
    commonalityMinPopulation: 20,
    populationSize: 200
  }));
  const cpFamily = populationRun.evidenceFamilies.find((f) => f.family === "COUNTERPARTY_OVERLAP");
  assert.ok(cpFamily, "rare shared counterparty still contributes a family");
  assert.ok(populationRun.correlationScore >= 20, `score ${populationRun.correlationScore}`);
});

test("POSITIVE CONTROL: rare counterparty + funding + temporal evidence beats shared hub only (population-aware)", () => {
  // Rare shared counterparty with funding flow between A and B.
  const rareCp = sharedCp(RARE_CP, 4);
  const fundingA = [transfer(B, A, 10), transfer(B, A, 12), transfer(B, A, 8), transfer(B, A, 15), transfer(B, A, 20)];
  const hub = sharedCp(COMMON_CP, 10);

  const meaningful = computeCorrelation(baseInput({
    transfersA: [...rareCp.transfersA, ...fundingA],
    transfersB: [...rareCp.transfersB],
    transactionCountA: 60,
    transactionCountB: 60,
    commonalityByAddress: new Map([[RARE_CP, 0.004], [COMMON_CP, 0.7]]),
    commonalityMinPopulation: 20,
    populationSize: 200
  }));
  const hubOnly = computeCorrelation(baseInput({
    transfersA: hub.transfersA,
    transfersB: hub.transfersB,
    commonalityByAddress: new Map([[COMMON_CP, 0.7]]),
    commonalityMinPopulation: 20,
    populationSize: 200
  }));
  assert.ok(meaningful.correlationScore > hubOnly.correlationScore + 30,
    `meaningful ${meaningful.correlationScore} vs hub ${hubOnly.correlationScore}`);
  assert.ok(hubOnly.correlationScore < 35, `hub score ${hubOnly.correlationScore}`);
});

test("FALLBACK: population map ignored below the minimum population (static behavior preserved)", () => {
  const { transfersA, transfersB } = sharedCp(COMMON_CP, 1);
  const staticRun = computeCorrelation(baseInput({ transfersA, transfersB }));
  const smallPopRun = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    commonalityByAddress: new Map([[COMMON_CP, 0.9]]),
    // The observed population is below the configured minimum → the
    // frequency must not influence the calculation.
    commonalityMinPopulation: 100,
    populationSize: 50
  }));
  assert.equal(smallPopRun.correlationScore, staticRun.correlationScore);
  // And once the population crosses the minimum the same map DOES apply.
  const bigPopRun = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    commonalityByAddress: new Map([[COMMON_CP, 0.9]]),
    commonalityMinPopulation: 100,
    populationSize: 200
  }));
  assert.ok(bigPopRun.correlationScore <= staticRun.correlationScore,
    `bigPop ${bigPopRun.correlationScore} vs static ${staticRun.correlationScore}`);
});

test("FALLBACK: absent frequencies leave static rarity untouched", () => {
  const { transfersA, transfersB } = sharedCp(RARE_CP, 3);
  const without = computeCorrelation(baseInput({ transfersA, transfersB }));
  const withEmptyMap = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    commonalityByAddress: new Map<string, number>(),
    commonalityMinPopulation: 20
  }));
  assert.equal(withEmptyMap.correlationScore, without.correlationScore);
});

test("ENTITY: population-aware frequency discounts a verified common entity overlap", () => {
  // Both wallets touch the same verified entity (e.g., an exchange).
  const transfersA = [transfer(UNCOMMON_ENTITY, A, 1), transfer(UNCOMMON_ENTITY, A, 2)];
  const transfersB = [transfer(UNCOMMON_ENTITY, B, 1), transfer(UNCOMMON_ENTITY, B, 2)];
  const entityAddresses = new Set([UNCOMMON_ENTITY]);
  const staticRun = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    knownEntityAddresses: entityAddresses
  }));
  // The entity is NOT in the D5 static COMMON_ENTITIES set, so static
  // overlap treats it as uncommon. Under population data it is very common
  // (exchange used by 60% of analyzed wallets) — the population penalty
  // must reduce the contribution.
  const populationRun = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    knownEntityAddresses: entityAddresses,
    commonalityByAddress: new Map([[UNCOMMON_ENTITY, 0.6]]),
    commonalityMinPopulation: 20
  }));
  const staticEntity = staticRun.evidenceFamilies.find((f) => f.family === "ENTITY_OVERLAP");
  const popEntity = populationRun.evidenceFamilies.find((f) => f.family === "ENTITY_OVERLAP");
  assert.ok(staticEntity && popEntity, "entity overlap family exists in both runs");
  assert.ok(popEntity.strength <= staticEntity.strength + 1e-9,
    `pop ${popEntity.strength} vs static ${staticEntity.strength}`);
});

test("SAMPLE: entity evidence with common mints excluded stays clean", () => {
  const transfersA = [transfer(MINT, A, 5), transfer(MINT, A, 3)];
  const transfersB = [transfer(MINT, B, 5), transfer(MINT, B, 3)];
  const r = computeCorrelation(baseInput({
    transfersA,
    transfersB,
    commonalityByAddress: new Map([[MINT, 0.9]]),
    commonalityMinPopulation: 20
  }));
  assert.ok(!r.evidenceFamilies.some((f) => f.family === "COUNTERPARTY_OVERLAP"),
    "common mint is excluded from counterparty evidence");
  assert.ok(r.correlationScore < 25, `score ${r.correlationScore}`);
});
