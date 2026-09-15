import test from "node:test";
import assert from "node:assert/strict";
import type { BlockchainProvider } from "@aegix/blockchain";
import { getIndexedTransaction } from "./indexed-transaction.js";

test("uses parsed indexed transactions, falling back for old JSON or failed index reads", async () => {
  let calls = 0;
  const provider = { name: "rpc", getTransaction: async () => { calls++; return null; } } as unknown as BlockchainProvider;
  const parsed = { slot: 1, blockTime: null, transaction: { signatures: ["sig"], message: { accountKeys: [{ pubkey: "wallet" }] } } };
  const result = await getIndexedTransaction("sig", provider, async () => parsed);
  assert.equal(result.source, "aegix-finalized-index");
  assert.equal(calls, 0);
  await getIndexedTransaction("other", provider, async () => parsed);
  await getIndexedTransaction("sig", provider, async () => { throw new Error("offline"); });
  await getIndexedTransaction("sig", provider, async () => null);
  assert.equal(calls, 3);
});
