/**
 * D5-F entity overlap tests: commonality-aware entity overlap (§29-§30),
 * record-confidence separation (§28), and safe language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateEntityOverlap, type OverlapInput } from "./dimensions/overlap.js";

const WALLET_A = "WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const UNCOMMON_ENTITY = "UncommonEntity1111111111111111111111111111111";
const LOW_CONF_ENTITY = "LowConfEntity11111111111111111111111111111111";

function transfer(from: string, to: string): OverlapInput["transfersA"][number] {
  return {
    id: "t",
    transaction_id: "sig",
    from_address: from,
    to_address: to,
    asset_type: "SOL",
    mint: null,
    amount_raw: "1",
    amount_normalized: "1",
    transfer_type: "TRANSFER",
    block_time: "2026-01-01T00:00:00Z"
  };
}

function baseInput(overrides: Partial<OverlapInput>): OverlapInput {
  return {
    walletA: WALLET_A,
    walletB: WALLET_B,
    transfersA: [],
    transfersB: [],
    knownEntityAddresses: new Set([JUPITER, UNCOMMON_ENTITY, LOW_CONF_ENTITY]),
    entityNamesByAddress: new Map([
      [JUPITER, "Jupiter"],
      [UNCOMMON_ENTITY, "Rare Protocol"],
      [LOW_CONF_ENTITY, "Unverified-ish Protocol"]
    ]),
    entityConfidenceByAddress: new Map([
      [JUPITER, 0.98],
      [UNCOMMON_ENTITY, 0.9],
      [LOW_CONF_ENTITY, 0.4]
    ]),
    ...overrides
  };
}

test("ENTITY: shared Jupiter only stays weak (commonality penalty)", () => {
  const r = evaluateEntityOverlap(baseInput({
    transfersA: [transfer(JUPITER, WALLET_A)],
    transfersB: [transfer(JUPITER, WALLET_B)]
  }));
  assert.ok(r !== null, "family present");
  assert.ok(r.strength < 0.15, `strength ${r.strength} must be near-zero for common entity`);
  assert.ok(r.evidence.some((e) => e.label.includes("(common)")), "evidence marks the entity as common");
});

test("ENTITY: shared uncommon verified entity is stronger", () => {
  const r = evaluateEntityOverlap(baseInput({
    transfersA: [transfer(UNCOMMON_ENTITY, WALLET_A), transfer(UNCOMMON_ENTITY, WALLET_A), transfer(UNCOMMON_ENTITY, WALLET_A)],
    transfersB: [transfer(UNCOMMON_ENTITY, WALLET_B), transfer(UNCOMMON_ENTITY, WALLET_B)]
  }));
  assert.ok(r !== null);
  assert.ok(r.strength > 0.25, `strength ${r.strength}`);
  assert.ok(r.summary.includes("uncommon"), "summary mentions uncommon");
});

test("ENTITY: record verification confidence separates from exposure confidence", () => {
  // Same interaction pattern, but one entity has a low record confidence.
  const strong = evaluateEntityOverlap(baseInput({
    transfersA: [transfer(UNCOMMON_ENTITY, WALLET_A), transfer(UNCOMMON_ENTITY, WALLET_A)],
    transfersB: [transfer(UNCOMMON_ENTITY, WALLET_B), transfer(UNCOMMON_ENTITY, WALLET_B)]
  }))!;
  const weak = evaluateEntityOverlap(baseInput({
    transfersA: [transfer(LOW_CONF_ENTITY, WALLET_A), transfer(LOW_CONF_ENTITY, WALLET_A)],
    transfersB: [transfer(LOW_CONF_ENTITY, WALLET_B), transfer(LOW_CONF_ENTITY, WALLET_B)]
  }))!;
  assert.ok(weak.confidence < strong.confidence, `record confidence must reduce family confidence (${weak.confidence} < ${strong.confidence})`);
});

test("ENTITY: repeated interaction with uncommon entity beats single touch", () => {
  const single = evaluateEntityOverlap(baseInput({
    transfersA: [transfer(UNCOMMON_ENTITY, WALLET_A)],
    transfersB: [transfer(UNCOMMON_ENTITY, WALLET_B)]
  }))!;
  const repeated = evaluateEntityOverlap(baseInput({
    transfersA: [transfer(UNCOMMON_ENTITY, WALLET_A), transfer(UNCOMMON_ENTITY, WALLET_A), transfer(UNCOMMON_ENTITY, WALLET_A), transfer(UNCOMMON_ENTITY, WALLET_A), transfer(UNCOMMON_ENTITY, WALLET_A)],
    transfersB: [transfer(UNCOMMON_ENTITY, WALLET_B), transfer(UNCOMMON_ENTITY, WALLET_B), transfer(UNCOMMON_ENTITY, WALLET_B), transfer(UNCOMMON_ENTITY, WALLET_B)]
  }))!;
  assert.ok(repeated.strength > single.strength, `repeated ${repeated.strength} > single ${single.strength}`);
});

test("ENTITY: safe language — never ownership claims", () => {
  const r = evaluateEntityOverlap(baseInput({
    transfersA: [transfer(UNCOMMON_ENTITY, WALLET_A)],
    transfersB: [transfer(UNCOMMON_ENTITY, WALLET_B)]
  }))!;
  const text = JSON.stringify(r).toLowerCase();
  assert.ok(!text.includes("same owner"));
  assert.ok(!text.includes("owned by"));
  assert.ok(!text.includes("identity match"));
});
