import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedTransfer } from "@aegix/types";
import { analyzeCounterparties } from "./engines/counterparty.js";
import { analyzeFunding } from "./engines/funding.js";
function transfer(from: string, to: string, amount: number, timestamp = "2026-01-01T00:00:00Z"): NormalizedTransfer {
  return {
    chain: "solana",
    transactionId: `tx-${from}-${to}-${amount}`,
    timestamp,
    fromAddress: from,
    toAddress: to,
    assetType: "SOL",
    mint: null,
    amountRaw: String(amount * 1e9),
    amountNormalized: amount,
    transferType: "TRANSFER"
  };
}

test("funding engine detects repeated funder", () => {
  const result = analyzeFunding({
    walletAddress: "walletA",
    transfers: [
      transfer("funder1", "walletA", 1),
      transfer("funder1", "walletA", 2),
      transfer("funder1", "walletA", 3),
      transfer("funder2", "walletA", 10)
    ]
  });

  assert.equal(result.fundingSources.length, 2);
  assert.equal(result.repeatedFunders.length, 1);
  assert.equal(result.repeatedFunders[0]!.address, "funder1");
  assert.ok(result.signals.some((s) => s.type === "REPEATED_FUNDING"));
});

test("funding engine flags high concentration", () => {
  const result = analyzeFunding({
    walletAddress: "walletA",
    transfers: [transfer("big", "walletA", 100), transfer("small", "walletA", 1)]
  });

  assert.equal(result.fundingConcentration, 100 / 101);
  assert.ok(result.signals.some((s) => s.type === "FUNDING_CONCENTRATION"));
});

test("counterparty engine counts unique and repeated counterparties", () => {
  const result = analyzeCounterparties({
    walletAddress: "walletA",
    transfers: [
      transfer("walletA", "alice", 5),
      transfer("walletA", "alice", 3),
      transfer("bob", "walletA", 2)
    ]
  });

  assert.equal(result.uniqueCounterparties, 2);
  assert.equal(result.repeatCounterpartyRatio, 0.5);
  assert.equal(result.counterparties[0]!.address, "alice");
  assert.ok(result.signals.some((s) => s.type === "REPEATED_COUNTERPARTY"));
});
