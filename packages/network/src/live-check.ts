/** Read-only mainnet RPC smoke check, writes only to a fresh scratch database. */
import postgres from "postgres";
import { createBlockSource, createRpc } from "./rpc.js";
import { createIndexStore } from "./store.js";
import { createNetworkQuery } from "./query.js";
import { indexBatch } from "./indexer.js";
import { readFile } from "node:fs/promises";
import type { NetworkChain } from "./chains.js";
import assert from "node:assert/strict";

const url = process.env.NETWORK_LIVE_TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/network_live_test") throw new Error("network_live_test database required");
const sql = postgres(url);
try {
  for (const migration of ["0012_network_foundation.sql", "0013_network_operations.sql", "0014_network_retention_indexes.sql"]) {
    await sql.unsafe(await readFile(new URL(`../../database/migrations/${migration}`, import.meta.url), "utf8"));
  }
  for (const [chain, endpoint] of [["solana:mainnet", process.env.SOLANA_LIVE_RPC_URL ?? "https://api.mainnet-beta.solana.com"], ["eip155:8453", "https://mainnet.base.org"]] as Array<[NetworkChain, string]>) {
    const source = createBlockSource(chain, createRpc(endpoint, 400));
    await source.verifyNetwork();
    const finalized = await source.finalizedHeight();
    const result = await indexBatch(source, createIndexStore(sql), finalized - 1, 2);
    const [membership] = await sql`select address from network_transaction_addresses where chain = ${chain} limit 1`;
    assert.ok(membership, "live blocks contain address projections");
    const history = await createNetworkQuery(sql).history(chain, membership.address, 2);
    assert.ok(history.transactions.length > 0);
    console.log(JSON.stringify({ chain, status: "passed", indexed: result.indexed, nextHeight: result.nextHeight,
      sampleTransactions: history.transactions.length }));
  }
} finally { await sql.end(); }
