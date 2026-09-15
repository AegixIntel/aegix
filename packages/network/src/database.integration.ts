/** Runs only against an explicitly provided scratch database; never resets data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createAexLedger } from "./economics.js";
import { createIndexStore } from "./store.js";
import { runIndexer } from "./runner.js";
import { pruneIndex } from "./maintenance.js";
import { createNetworkQuery } from "./query.js";

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
  await isolated.unsafe(await readFile(new URL("../../database/migrations/0014_network_retention_indexes.sql", import.meta.url), "utf8"));
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

  // Retention is bounded and repeatable: it must never cross the cursor, must
  // report the floor it leaves behind, and must be safe to run twice.
  const wallet = "11111111111111111111111111111111";
  const withTransaction = (at: number) => ({ chain: "solana:mainnet" as const, height: at, hash: `h${at}`,
    parentHeight: at - 1, parentHash: `h${at - 1}`,
    raw: { blockTime: 1_700_000_000, transactions: [{ transaction: { signatures: [`sig-${at}`],
      message: { accountKeys: [{ pubkey: wallet }] } }, meta: { err: null, fee: 1 } }] } });
  await store.commit("solana:mainnet", await store.checkpoint("solana:mainnet", 10), 13,
    [withTransaction(11), withTransaction(12)]);
  await assert.rejects(pruneIndex(isolated, "solana:mainnet", { before: 500 }), /cursor/);

  // The row budget bounds one invocation independently of the block count: a
  // block with no memberships costs nothing, so the stop happens once the first
  // block with rows is taken.
  const bounded = await pruneIndex(isolated, "solana:mainnet", { before: 13, batch: 10, rowBudget: 1 });
  assert.equal(bounded.done, false, "a budgeted prune reports that work remains");
  assert.equal(bounded.retainedFloor, 12, "the floor is reported while some blocks remain");
  const rest = await pruneIndex(isolated, "solana:mainnet", { before: 13, batch: 10, rowBudget: 1_000 });
  assert.equal(rest.done, true, "nothing below the bound remains");
  assert.equal(bounded.deletedBlocks + rest.deletedBlocks, 3, "every block below the bound is removed");
  assert.equal(rest.retainedFloor, null, "an emptied index retains no floor");
  assert.equal((await pruneIndex(isolated, "solana:mainnet", { before: 13 })).deletedBlocks, 0,
    "a repeated prune deletes nothing");
  // An index that was populated and then fully pruned must not read as a wallet
  // with no activity.
  const disclosure = await createNetworkQuery(isolated).history("solana:mainnet", wallet, 5);
  assert.ok(disclosure.limitations.some(line => line.includes("pruned by retention")),
    "an emptied index still discloses retention");
  // Deleting a transaction must not be possible while its memberships remain.
  const [dangling] = await isolated`select count(*)::int as rows from network_transaction_addresses a
    left join network_transactions t on t.chain = a.chain and t.tx_id = a.tx_id where t.tx_id is null`;
  assert.equal(dangling?.rows, 0, "retention leaves no orphaned memberships");

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
  console.log(JSON.stringify({ status: "passed", schema, checks: ["migration", "checkpoint CAS", "rollback", "start mismatch", "retention prune", "prune bound guard", "concurrent replay", "payload conflict", "concurrent overdraft", "conservation"] }));
} finally {
  await isolated.end();
  await sql.end();
}
