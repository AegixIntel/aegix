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

/** Unwraps a ParseOutcome, failing the test if parsing failed. */
function unwrap(outcome: ReturnType<typeof normalizeTransaction>) {
  assert.equal(outcome.failed, false, outcome.failureReason ?? "parse failed");
  assert.ok(outcome.result, "expected a result");
  return outcome.result;
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

  const r = unwrap(result);

  assert.equal(r.transaction.transactionClass, "UNKNOWN");
  assert.equal(r.transfers.length, 1);
  const t = r.transfers[0]!;
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

  const r = unwrap(result);

  assert.equal(r.transfers.length, 1);
  const t = r.transfers[0]!;
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
  const r = unwrap(result);
  assert.equal(r.transaction.success, false);
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

  const r = unwrap(result);

  assert.equal(r.interactions.length, 1);
  const ix = r.interactions[0]!;
  assert.equal(ix.programLabel, "Jupiter");
  assert.equal(ix.protocolCategory, "DEX");
  assert.equal(ix.actionType, "SWAP");
});

test("classifies fully parsed protocol transactions", () => {
  const outcome = normalizeTransaction({
    signature: "sig5",
    raw: tx([
      { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", program: "jupiter", parsed: { type: "swap" } }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });
  assert.equal(outcome.parseClass, "FULLY_PARSED");
  assert.equal(outcome.semanticCoverage, 1);
});

test("classifies generic transfer-only transactions", () => {
  const outcome = normalizeTransaction({
    signature: "sig6",
    raw: tx([
      { programId: SYSTEM_PROGRAM, program: "system", parsed: { type: "transfer", info: { from: "a", to: "b", lamports: 1000 } } }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });
  assert.equal(outcome.parseClass, "GENERIC_PARSED");
  assert.equal(outcome.semanticCoverage, 1);
});

test("classifies partially parsed transactions (known program, unknown action)", () => {
  const outcome = normalizeTransaction({
    signature: "sig7",
    raw: tx([
      { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", program: "jupiter", parsed: { type: "someUnknownAction" } }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });
  assert.equal(outcome.parseClass, "PARTIALLY_PARSED");
  assert.ok(outcome.semanticCoverage < 1);
});

test("recognizes new protocol parsers (Metaplex, Orca, Marinade)", () => {
  const cases: Array<[string, string, string]> = [
    ["metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", "createMetadataAccountV3", "CREATE_METADATA"],
    ["9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", "swap", "SWAP"],
    ["MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", "deposit", "DEPOSIT"]
  ];
  for (const [programId, action, expected] of cases) {
    const outcome = normalizeTransaction({
      signature: `sig-${action}`,
      raw: tx([{ programId, program: "protocol", parsed: { type: action } }]),
      walletAddress: "walletA",
      rawProvider: "test"
    });
    const r = unwrap(outcome);
    assert.equal(outcome.parseClass, "FULLY_PARSED", `${programId} should be fully parsed`);
    assert.equal(r.interactions[0]!.actionType, expected);
    assert.equal(r.interactions[0]!.protocolCategory === "UNKNOWN", false);
  }
});

test("recognized programs with opaque instructions fall back to generic action (D3-B)", () => {
  // Real Metaplex instructions come as opaque base58 `data` without a parsed
  // type — the program is recognized, so the interaction must still be
  // semantically classified instead of UNKNOWN.
  const outcome = normalizeTransaction({
    signature: "sig-metaplex-opaque",
    raw: tx([
      { programId: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", program: "metaplex", data: "3zRedDvfuC4YZdreTwV8KBm16Vk6tAWDk5XFLywbBjgEDjfxUUBZFTEr9HFNvnSrEieXVdGZ2ZtYM8NPukefk9RSog9wGsNmDzWF" }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });
  const r = unwrap(outcome);
  assert.equal(outcome.parseClass, "FULLY_PARSED");
  assert.equal(r.interactions[0]!.actionType, "METADATA_INTERACTION");
  assert.equal(r.interactions[0]!.protocolCategory, "NFT");
});

test("marketplace programs without parsed actions classify as MARKETPLACE_INTERACTION", () => {
  const outcome = normalizeTransaction({
    signature: "sig-me",
    raw: tx([
      { programId: "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", program: "magic-eden", data: "abc" }
    ]),
    walletAddress: "walletA",
    rawProvider: "test"
  });
  const r = unwrap(outcome);
  assert.equal(outcome.parseClass, "FULLY_PARSED");
  assert.equal(r.interactions[0]!.actionType, "MARKETPLACE_INTERACTION");
});
