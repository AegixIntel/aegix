import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedTransaction, NormalizedTransfer, TransferType } from "@aegix/types";
import { analyzeTransactionPatterns } from "./transaction-pattern.js";

const WALLET = "walletA";

function transfer(amount: number, transferType: TransferType = "TRANSFER"): NormalizedTransfer {
  return {
    chain: "solana",
    transactionId: `tx-${amount}-${transferType}`,
    timestamp: "2026-01-01T00:00:00Z",
    fromAddress: WALLET,
    toAddress: "counterparty",
    assetType: "SOL",
    mint: null,
    amountRaw: String(Math.round(amount * 1e9)),
    amountNormalized: amount,
    transferType
  };
}

function tx(blockTime: string): NormalizedTransaction {
  return {
    chain: "solana",
    signature: `sig-${blockTime}`,
    slot: 1,
    blockTime,
    walletId: WALLET,
    success: true,
    fee: 5000,
    transactionClass: "TRANSFER",
    transfers: [],
    programInteractions: [],
    rawProvider: "test",
    parserVersion: "test",
    createdAt: blockTime
  };
}

/** `count` transactions spaced evenly `stepMinutes` apart from a fixed start. */
function evenlySpaced(count: number, stepMinutes: number, startIso = "2026-01-01T06:00:00Z"): NormalizedTransaction[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => tx(new Date(start + i * stepMinutes * 60_000).toISOString()));
}

test("empty input produces no signals and zero exposure", () => {
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions: [], transfers: [] });

  assert.equal(result.signals.length, 0);
  assert.equal(result.largeTransferExposure, 0);
  assert.equal(result.highFrequencyExposure, 0);
  assert.equal(result.oddHourExposure, 0);
  assert.equal(result.regularIntervalExposure, 0);
});

test("outlier transfer amount raises a TRANSACTION_PATTERN signal", () => {
  const transfers = [...Array.from({ length: 10 }, () => transfer(1)), transfer(100)];
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions: [], transfers });

  const signal = result.signals.find((s) => s.type === "LARGE_TRANSFER_OUTLIER");
  assert.ok(signal, "expected a large-transfer signal");
  assert.equal(signal.category, "TRANSACTION_PATTERN");
  assert.equal(result.features.largeTransferRatio, 100);
  assert.ok(result.largeTransferExposure > 0);
});

test("a flat amount distribution raises no large-transfer signal", () => {
  const transfers = Array.from({ length: 10 }, () => transfer(1));
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions: [], transfers });

  assert.equal(result.signals.filter((s) => s.type === "LARGE_TRANSFER_OUTLIER").length, 0);
  assert.equal(result.largeTransferExposure, 0);
});

test("fees are excluded from the amount distribution", () => {
  const transfers = [...Array.from({ length: 10 }, () => transfer(1)), transfer(500, "FEE")];
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions: [], transfers });

  assert.equal(result.features.transfersConsidered, 10);
  assert.equal(result.signals.filter((s) => s.type === "LARGE_TRANSFER_OUTLIER").length, 0);
});

test("high transaction frequency is measured, not proxied from the count", () => {
  // 40 transactions across a single day.
  const result = analyzeTransactionPatterns({
    walletAddress: WALLET,
    transactions: evenlySpaced(40, 36),
    transfers: []
  });

  const signal = result.signals.find((s) => s.type === "HIGH_FREQUENCY_ACTIVITY");
  assert.ok(signal, "expected a high-frequency signal");
  assert.ok(result.features.transactionsPerDay >= 20, `got ${result.features.transactionsPerDay}/day`);
  assert.ok(result.highFrequencyExposure > 0);
});

test("a low transaction rate raises no frequency signal", () => {
  // 25 transactions spread over 25 days.
  const result = analyzeTransactionPatterns({
    walletAddress: WALLET,
    transactions: evenlySpaced(25, 24 * 60),
    transfers: []
  });

  assert.equal(result.signals.filter((s) => s.type === "HIGH_FREQUENCY_ACTIVITY").length, 0);
  // Exposure scales continuously with the rate, so ~1 tx/day is a small
  // non-zero value rather than a hard zero.
  assert.ok(result.highFrequencyExposure < 10, `got ${result.highFrequencyExposure}`);
});

test("activity concentrated in the low-activity UTC band is flagged", () => {
  const start = new Date("2026-01-01T01:00:00Z").getTime();
  // 20 transactions, all inside 01:00-04:00 UTC across consecutive days.
  const transactions = Array.from({ length: 20 }, (_, i) =>
    tx(new Date(start + i * 24 * 3_600_000 + (i % 3) * 3_600_000).toISOString())
  );
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions, transfers: [] });

  const signal = result.signals.find((s) => s.type === "ODD_HOUR_CONCENTRATION");
  assert.ok(signal, "expected an odd-hour signal");
  assert.equal(result.features.oddHourShare, 1);
  assert.equal(result.oddHourExposure, 100);
});

test("uniform hour coverage produces no odd-hour exposure", () => {
  // One transaction per hour across a full day.
  const result = analyzeTransactionPatterns({
    walletAddress: WALLET,
    transactions: evenlySpaced(24, 60, "2026-01-01T00:00:00Z"),
    transfers: []
  });

  assert.equal(result.oddHourExposure, 0);
  assert.equal(result.signals.filter((s) => s.type === "ODD_HOUR_CONCENTRATION").length, 0);
});

test("reused exact amounts are flagged as a correlation surface", () => {
  const transfers = [
    ...Array.from({ length: 5 }, () => transfer(2)),
    transfer(1),
    transfer(3),
    transfer(4),
    transfer(5),
    transfer(6)
  ];
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions: [], transfers });

  const signal = result.signals.find((s) => s.type === "REPEATED_EXACT_AMOUNT");
  assert.ok(signal, "expected a repeated-amount signal");
  assert.equal(result.features.repeatedAmountShare, 0.5);
  assert.equal(signal.category, "TRANSACTION_PATTERN");
});

test("amounts repeated below the occurrence floor are not flagged", () => {
  const transfers = [transfer(2), transfer(2), transfer(1), transfer(3), transfer(4)];
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions: [], transfers });

  assert.equal(result.signals.filter((s) => s.type === "REPEATED_EXACT_AMOUNT").length, 0);
  assert.equal(result.features.repeatedAmountShare, 0);
});

test("periodic intervals read as automation", () => {
  const result = analyzeTransactionPatterns({
    walletAddress: WALLET,
    transactions: evenlySpaced(10, 6 * 60),
    transfers: []
  });

  const signal = result.signals.find((s) => s.type === "REGULAR_INTERVAL_ACTIVITY");
  assert.ok(signal, "expected a regular-interval signal");
  assert.equal(result.features.intervalRegularity, 1);
  assert.equal(result.regularIntervalExposure, 100);
});

test("irregular intervals produce no regularity signal", () => {
  const offsetsMinutes = [0, 5, 600, 610, 20_000, 20_100, 90_000];
  const start = new Date("2026-01-01T06:00:00Z").getTime();
  const transactions = offsetsMinutes.map((m) => tx(new Date(start + m * 60_000).toISOString()));
  const result = analyzeTransactionPatterns({ walletAddress: WALLET, transactions, transfers: [] });

  assert.equal(result.signals.filter((s) => s.type === "REGULAR_INTERVAL_ACTIVITY").length, 0);
  assert.ok(result.regularIntervalExposure < 75, `got ${result.regularIntervalExposure}`);
});

test("too few intervals never report regularity", () => {
  const result = analyzeTransactionPatterns({
    walletAddress: WALLET,
    transactions: evenlySpaced(3, 60),
    transfers: []
  });

  assert.equal(result.regularIntervalExposure, 0);
  assert.equal(result.features.intervalRegularity, 0);
});
