import assert from "node:assert/strict";
import { test } from "node:test";
import { detectTransactionClass, normalizeTransaction } from "./normalizer.js";
import type { ParsedTransactionLike } from "./types.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function tx(instructions: Array<Record<string, unknown>>): ParsedTransactionLike {
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    meta: { err: null, fee: 5000, preBalances: [], postBalances: [] },
    transaction: {
      message: {
        accountKeys: [],
        instructions: instructions as never
      }
    }
  } as unknown as ParsedTransactionLike;
}

test("normalizes a simple SOL transfer", () => {
  const result = normalizeTransaction({
    signature: "sig1",
    raw: tx([
      {
        programId: SYSTEM_PROGRAM,
        program: "system",
        parsed: { type: "transfer", info: { from: "walletA", to: "walletB", lamports: 1_000_000_000 } }
      }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });

  assert.equal(result.transaction.transactionClass, "UNKNOWN");
  assert.equal(result.transfers.length, 1);
  const t = result.transfers[0]!;
  assert.equal(t.fromAddress, "walletA");
  assert.equal(t.toAddress, "walletB");
  assert.equal(t.assetType, "SOL");
  assert.equal(t.amountNormalized, 1);
  assert.equal(t.amountRaw, "1000000000");
});

test("normalizes an SPL token transfer", () => {
  const result = normalizeTransaction({
    signature: "sig2",
    raw: tx([
      {
        programId: TOKEN_PROGRAM,
        program: "spl-token",
        parsed: {
          type: "transfer",
          info: { authority: "walletA", source: "src", destination: "dst", tokenAmount: { amount: "2500", decimals: 6 } }
        }
      }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });

  assert.equal(result.transfers.length, 1);
  const t = result.transfers[0]!;
  assert.equal(t.assetType, "SPL");
  assert.equal(t.transferType, "TRANSFER");
  assert.equal(t.amountRaw, "2500");
});

test("detects swap class for jupiter instructions", () => {
  const klass = detectTransactionClass([
    { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", program: "jupiter" }
  ]);
  assert.equal(klass, "SWAP");
});

test("treats failed transactions as not successful", () => {
  const raw = tx([{ programId: SYSTEM_PROGRAM, program: "system", parsed: { type: "transfer", info: {} } }]);
  raw.meta!.err = "InstructionError";
  const result = normalizeTransaction({
    signature: "sig3",
    raw,
    walletAddress: "walletA",
    rawProvider: "test"
  });
  assert.equal(result.transaction.success, false);
});

test("records program interactions with category", () => {
  const result = normalizeTransaction({
    signature: "sig4",
    raw: tx([
      { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", program: "jupiter", parsed: { type: "swap" } }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });

  assert.equal(result.interactions.length, 1);
  const ix = result.interactions[0]!;
  assert.equal(ix.programLabel, "Jupiter");
  assert.equal(ix.protocolCategory, "DEX");
  assert.equal(ix.actionType, "SWAP");
});
