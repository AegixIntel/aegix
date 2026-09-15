import test from "node:test";
import assert from "node:assert/strict";
import { projectBlock } from "./projection.js";

test("Solana includes parsed account membership and does not invent sender/value", () => {
  const key = "11111111111111111111111111111111";
  const txs = projectBlock({ chain: "solana:mainnet", height: 10, hash: "h10", parentHeight: 9, parentHash: "h9", raw: {
    blockTime: 1700000000, transactions: [{ transaction: { signatures: ["sig"], message: { accountKeys: [{ pubkey: key }, { pubkey: key }] } }, meta: { err: null } }]
  } });
  assert.deepEqual(txs[0]?.addresses, [key]);
  assert.equal(txs[0]?.success, true);
  assert.equal(txs[0]?.value_atomic, null);
});
test("EVM preserves large amounts, chain-local addresses and unknown execution", () => {
  const from = `0x${"Aa".repeat(20)}`;
  const txs = projectBlock({ chain: "eip155:1", height: 10, hash: "h10", parentHeight: 9, parentHash: "h9", raw: {
    timestamp: "0x65", transactions: [{ hash: "tx", from, to: null, value: "0xffffffffffffffff" }]
  } });
  assert.equal(txs[0]?.value_atomic, "18446744073709551615");
  assert.equal(txs[0]?.sender, from.toLowerCase());
  assert.equal(txs[0]?.success, null);
  assert.equal(txs[0]?.recipient, null);
});
