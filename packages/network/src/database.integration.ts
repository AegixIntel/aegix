/** Runs only against an explicitly provided scratch database; never resets data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createAexLedger } from "./economics.js";
import { createIndexStore } from "./store.js";
import { runIndexer } from "./runner.js";

const url = process.env.NETWORK_TEST_DATABASE_URL;
if (!url) throw new Error("NETWORK_TEST_DATABASE_URL required");
const sql = postgres(url, { max: 4 });
const schema = `network_test_${randomUUID().replaceAll("-", "")}`;
// Each connection gets the same isolated schema. No DROP/TRUNCATE or production reset.
const isolated = postgres(url, { max: 4, connection: { search_path: schema } });
try {
  await sql`create schema ${sql(schema)}`;
  const migration = await readFile(new URL("../../database/migrations/0012_network_foundation.sql", import.meta.url), "utf8");
  await isolated.unsafe(migration);
  await isolated.unsafe(await readFile(new URL("../../database/migrations/0013_network_operations.sql", import.meta.url), "utf8"));
  const store = createIndexStore(isolated);
  const initial = await store.checkpoint("solana:mainnet", 10);
  const block = { chain: "solana:mainnet" as const, height: 10, hash: "h10", parentHeight: 9, parentHash: "h9", raw: { transactions: [] } };
  await store.commit("solana:mainnet", initial, 11, [block]);
  await assert.rejects(store.commit("solana:mainnet", initial, 11, [block]), /Checkpoint changed/);
  const current = await store.checkpoint("solana:mainnet", 10);
  assert.equal(current.nextHeight, 11);
  await assert.rejects(store.commit("solana:mainnet", current, 12, [{ ...block, height: 11 }]));
  assert.equal((await store.checkpoint("solana:mainnet", 10)).nextHeight, 11, "failed block write rolls back cursor");
  await assert.rejects(store.checkpoint("solana:mainnet", 9), /Start height/);

  await isolated`insert into aex_accounts (id, balance) values ('treasury', 100), ('alice', 0), ('bob', 0)`;
  const ledger = createAexLedger(isolated);
  const transfer = { eventKey: "bounty-1", debitAccount: "treasury", creditAccount: "alice", amount: "60", purpose: "RESEARCH_BOUNTY" as const, evidenceRef: "reviewed-case-1" };
  const replays = await Promise.all([ledger.transfer(transfer), ledger.transfer(transfer)]);
  assert.equal(replays.filter(result => result.replayed).length, 1);
  await assert.rejects(ledger.transfer({ ...transfer, amount: "61" }), /different transfer/);
  const competing = await Promise.allSettled([
    ledger.transfer({ ...transfer, eventKey: "bounty-2", amount: "30" }),
    ledger.transfer({ ...transfer, eventKey: "bounty-3", amount: "30", creditAccount: "bob" })
  ]);
  assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
  const [total] = await isolated`select sum(balance)::text as total, min(balance)::text as minimum from aex_accounts`;
  assert.equal(total?.total, "100", "ledger conserves funds");
  assert.ok(BigInt(total!.minimum) >= 0n);
  const [count] = await isolated`select count(*)::int as count from aex_transfers`;
  assert.equal(count?.count, 2, "only successful unique transfers are recorded");
  const controller = new AbortController();
  let attempts = 0;
  const events: Array<Record<string, unknown>> = [];
  await runIndexer({ source: {
    chain: "solana:mainnet", verifyNetwork: async () => { if (++attempts === 1) throw new Error("transient"); },
    finalizedHeight: async () => 10, firstAvailableHeight: async () => 0,
    heights: async () => [], block: async () => { throw new Error("caught up, no fetch expected"); }
  }, store, sql: isolated, start: 10, batchSize: 1, signal: controller.signal, once: false, pollMs: 1,
    log: event => { events.push(event); if (event.event === "indexed") controller.abort(); } });
  assert.equal(attempts, 2, "daemon retries a failed batch and drains on abort");
  assert.deepEqual(events.map(event => event.event), ["index_error", "indexed"]);
  const [health] = await isolated`select last_error, heartbeat_at, finalized_height::text from network_checkpoints where chain = 'solana:mainnet'`;
  assert.equal(health?.last_error, null);
  assert.ok(health?.heartbeat_at);
  assert.equal(health?.finalized_height, "10");
  console.log(JSON.stringify({ status: "passed", schema, checks: ["migration", "checkpoint CAS", "rollback", "start mismatch", "concurrent replay", "payload conflict", "concurrent overdraft", "conservation"] }));
} finally {
  await isolated.end();
  await sql.end();
}
