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
import { TRANSFER_TOPIC } from "./evm-receipts.js";

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
  await isolated.unsafe(await readFile(new URL("../../database/migrations/0019_evm_receipts.sql", import.meta.url), "utf8"));
  await isolated.unsafe(await readFile(new URL("../../database/migrations/0020_network_transfers.sql", import.meta.url), "utf8"));
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

  // A jsonParsed mainnet envelope carries NUL escapes inside its strings — slot
  // 425503014 has seven, in vote-account seed fields — and jsonb cannot store
  // U+0000. PostgreSQL rejects the insert, so an unsanitized block fails its
  // write, the cursor never advances, and the daemon retries that block
  // forever. The rejection is asserted first so the guard cannot be removed
  // without this test explaining why it exists.
  await assert.rejects(isolated`select ${isolated.json({ seed: "\u0000" })}::jsonb`, /Unicode escape/);
  const nulBlock = { chain: "solana:mainnet" as const, height: 13, hash: "h13", parentHeight: 12, parentHash: "h12",
    rawRpc: '{"seed":"\\u0000"}',
    raw: { blockTime: 1_700_000_000, seed: "\u0018\u0000\u0000", transactions: [{ transaction: { signatures: ["sig-nul"],
      message: { accountKeys: [{ pubkey: wallet }] } }, meta: { err: null, fee: 1, logMessages: ["seed\u0000value"] } }] } };
  await store.commit("solana:mainnet", await store.checkpoint("solana:mainnet", 10), 14, [nulBlock]);
  assert.equal((await store.checkpoint("solana:mainnet", 10)).nextHeight, 14, "a NUL-bearing block still commits");
  const [stored] = await isolated`select raw, raw_rpc from network_blocks where chain = 'solana:mainnet' and height = 13`;
  assert.equal(stored?.raw.seed, "\u0018\uFFFD\uFFFD", "the parsed copy records the code point it could not store");
  assert.equal(stored?.raw_rpc, '{"seed":"\\u0000"}', "the exact envelope is preserved in raw_rpc");
  const [storedTx] = await isolated`select raw from network_transactions where chain = 'solana:mainnet' and tx_id = 'sig-nul'`;
  assert.equal(storedTx?.raw.meta.logMessages[0], "seed\uFFFDvalue", "projected payloads are sanitized too");
  // Ingestion continues past the block rather than stalling on it.
  await store.commit("solana:mainnet", await store.checkpoint("solana:mainnet", 10), 15, [withTransaction(14)]);
  assert.equal((await store.checkpoint("solana:mainnet", 10)).nextHeight, 15, "the next block commits");

  // An EVM block is stored with hashes only and its trimmed receipts; the
  // transaction keeps its full payload and takes its execution from the receipt.
  const evmTx = `0x${"1".repeat(64)}`;
  const evmFrom = `0x${"a".repeat(40)}`;
  const evmBlock = { chain: "eip155:1" as const, height: 20, hash: `0x${"b".repeat(64)}`, parentHeight: 19, parentHash: `0x${"c".repeat(64)}`,
    raw: { number: "0x14", timestamp: "0x65", transactions: [{ hash: evmTx, from: evmFrom, to: evmFrom, value: "0x1", input: "0x" }] },
    receipts: [{ transactionHash: evmTx, transactionIndex: 0, status: 0 as const, from: evmFrom, gasUsed: "21000",
      effectiveGasPrice: "1", transferLogs: [] }] };
  await store.commit("eip155:1", await store.checkpoint("eip155:1", 20), 21, [evmBlock]);
  const [evmStored] = await isolated`select raw, raw_rpc, receipts from network_blocks where chain = 'eip155:1' and height = 20`;
  assert.deepEqual(evmStored?.raw.transactions, [evmTx], "the EVM block keeps transaction hashes only");
  assert.equal(evmStored?.raw_rpc, null, "an EVM block needs no raw_rpc envelope");
  assert.equal(evmStored?.receipts[0].status, 0, "the trimmed receipt is stored");
  const [evmRow] = await isolated`select success, raw from network_transactions where chain = 'eip155:1' and tx_id = ${evmTx}`;
  assert.equal(evmRow?.success, false, "a reverted transaction is recorded as failed");
  assert.equal(evmRow?.raw.input, "0x", "the transaction keeps its full payload");
  const [revertedTransfers] = await isolated`select count(*)::int as n from network_transfers where chain = 'eip155:1'`;
  assert.equal(revertedTransfers?.n, 0, "a reverted transaction records no transfer");

  // A successful transaction records its native amount and token events; a
  // wallet reads them from either side, newest first, across pages.
  const evmTo = `0x${"d".repeat(40)}`;
  const tokenAddress = `0x${"e".repeat(40)}`;
  const pad = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
  const okTx = `0x${"2".repeat(64)}`;
  const okBlock = { chain: "eip155:1" as const, height: 21, hash: `0x${"d".repeat(64)}`, parentHeight: 20, parentHash: evmBlock.hash,
    raw: { number: "0x15", timestamp: "0x66", transactions: [{ hash: okTx, from: evmFrom, to: tokenAddress, value: "0x5", input: "0x" }] },
    receipts: [{ transactionHash: okTx, transactionIndex: 0, status: 1 as const, from: evmFrom, gasUsed: "50000", effectiveGasPrice: "1",
      transferLogs: [
        { logIndex: 0, address: tokenAddress, topics: [TRANSFER_TOPIC, pad(evmFrom), pad(evmTo)], data: `0x${"0".repeat(63)}7` },
        { logIndex: 1, address: tokenAddress, topics: [TRANSFER_TOPIC, pad(evmTo), pad(evmFrom)], data: `0x${"0".repeat(64)}` },
        { logIndex: 2, address: tokenAddress, topics: [TRANSFER_TOPIC, pad(evmFrom), pad(evmFrom), `0x${"0".repeat(63)}9`], data: "0x" }] }] };
  await store.commit("eip155:1", await store.checkpoint("eip155:1", 20), 22, [okBlock]);
  const query = createNetworkQuery(isolated);
  const firstPage = await query.transfers("eip155:1", evmFrom, 2);
  assert.deepEqual(firstPage.transfers.map(t => [t.ordinal, t.kind, t.direction]), [[2, "ERC721", "SELF"], [1, "ERC20", "IN"]],
    "a self-transfer is listed once, newest first");
  assert.ok(firstPage.nextCursor);
  const secondPage = await query.transfers("eip155:1", evmFrom, 2, firstPage.nextCursor!);
  assert.deepEqual(secondPage.transfers.map(t => [t.ordinal, t.kind, t.direction, t.amount_atomic]),
    [[0, "ERC20", "OUT", "7"], [-1, "NATIVE", "OUT", "5"]], "the cursor continues where the page ended");
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual((await query.transfers("eip155:1", evmTo, 10)).transfers.map(t => t.direction), ["OUT", "IN"]);
  await assert.rejects(query.transfers("solana:mainnet", wallet, 10), /EVM chains only/);
  const recipientHistory = await query.history("eip155:1", evmTo, 10);
  assert.deepEqual(recipientHistory.transactions.map(t => t.tx_id), [okTx], "a token recipient sees the transaction in history");
  const signals = await query.signals("eip155:1", evmFrom);
  assert.deepEqual(signals.activity, { incoming: 1, outgoing: 2, self: 1, nativeIn: "0", nativeOut: "5", tokenContracts: 1, zeroAmountIncoming: 1 },
    "signals read the wallet's transfers from both sides");
  assert.deepEqual(signals.counterparties.map(c => [c.address, c.incoming, c.outgoing]), [[evmTo, 1, 1], [tokenAddress, 0, 1]]);
  assert.deepEqual(signals.lookAlikes, []);
  assert.equal(signals.sample.truncated, false);
  await assert.rejects(query.signals("solana:mainnet", wallet), /EVM chains only/);
  const evmPrune = await pruneIndex(isolated, "eip155:1", { before: 22 });
  assert.equal(evmPrune.deletedTransfers, 4, "retention removes transfers with their block");

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
  console.log(JSON.stringify({ status: "passed", schema, checks: ["migration", "checkpoint CAS", "rollback", "start mismatch", "retention prune", "prune bound guard", "nul escape payload", "evm receipts", "evm transfers", "concurrent replay", "payload conflict", "concurrent overdraft", "conservation"] }));
} finally {
  await isolated.end();
  await sql.end();
}
