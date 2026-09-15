import test from "node:test";
import assert from "node:assert/strict";
import { SolanaRpcProvider } from "./solana/provider.js";

test("JSON-RPC transaction reader opts into v1 and retains message config", async () => {
  const originalFetch = globalThis.fetch;
  const transactionConfig = { computeUnitLimit: 100000, loadedAccountsDataSizeLimit: 32768, priorityFee: 5 };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.method, "getTransaction");
    assert.equal(request.params[1].maxSupportedTransactionVersion, 1);
    assert.equal(request.params[1].encoding, "jsonParsed");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      slot: 100, blockTime: 1700000000, version: 1, transaction: { message: { transactionConfig, accountKeys: [] } }
    } }), { status: 200 });
  };
  try {
    const provider = new SolanaRpcProvider({ RPC_URL: "https://rpc.example.org" });
    const tx = await provider.getTransaction("test-signature");
    assert.equal((tx!.json as { version: number }).version, 1);
    assert.deepEqual((tx!.json as { transaction: { message: { transactionConfig: unknown } } }).transaction.message.transactionConfig, transactionConfig);
  } finally { globalThis.fetch = originalFetch; }
});
