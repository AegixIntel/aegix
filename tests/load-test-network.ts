/**
 * Network ingestion and read-path load harness.
 *
 * Measures the indexer write path and the wallet-history read path under
 * concurrency WITHOUT external RPC: blocks come from a deterministic in-process
 * source, so the numbers describe our code and PostgreSQL rather than a
 * provider. Live provider throughput is measured separately with the indexer
 * CLI (see docs/network-operations.md).
 *
 * It also exercises retention, because pruning is the other half of "this
 * database stays bounded".
 *
 * Usage: pnpm loadtest:network -- --batches 8 --blocks 24 --transactions 40 \
 *          --wallets 200 --queries 300 --concurrency 16
 * Flags:
 *   --batches        ingestion batches (default 8)
 *   --blocks         blocks per batch (default 24)
 *   --transactions   transactions per block (default 40)
 *   --wallets        distinct wallets in the seeded activity (default 200)
 *   --queries        concurrent history reads (default 300)
 *   --concurrency    simultaneous reads (default 16)
 *   --prune-fraction share of the indexed range to prune afterwards (default 0.5)
 *   --timeout        per-read timeout ms (default 10000)
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import bs58 from "bs58";
import { createDb } from "@aegix/database";
import { createIndexStore, createNetworkQuery, indexBatch, pruneIndex } from "@aegix/network";
import type { BlockSource, IndexedBlock } from "@aegix/network";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

function parseArgs(): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = /^\d+(\.\d+)?$/.test(next) ? Number(next) : next; i += 1; }
    else out[key] = true;
  }
  return out;
}

const flags = parseArgs();
const BATCHES = Number(flags.batches ?? 8);
const BLOCKS = Number(flags.blocks ?? 24);
const TRANSACTIONS = Number(flags.transactions ?? 40);
const WALLETS = Number(flags.wallets ?? 200);
const QUERIES = Number(flags.queries ?? 300);
const CONCURRENCY = Number(flags.concurrency ?? 16);
const PRUNE_FRACTION = Number(flags["prune-fraction"] ?? 0.5);
const TIMEOUT = Number(flags.timeout ?? 10000);
for (const [name, value, min, max] of [["batches", BATCHES, 1, 1000], ["blocks", BLOCKS, 1, 256],
  ["transactions", TRANSACTIONS, 1, 1000], ["wallets", WALLETS, 2, 100_000], ["queries", QUERIES, 1, 100_000],
  ["concurrency", CONCURRENCY, 1, 256], ["timeout", TIMEOUT, 100, 120_000]] as const) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid --${name}`);
}

const chain = "solana:mainnet" as const;
// Distinct valid Solana addresses: 32 random bytes, base58 encoded.
const wallets = Array.from({ length: WALLETS }, () => bs58.encode(randomBytes(32)));
const start = 500_000_000;

function blockAt(height: number, seed: number): IndexedBlock {
  const transactions = Array.from({ length: TRANSACTIONS }, (_, index) => {
    const a = wallets[(index + seed) % wallets.length]!;
    const b = wallets[(index + seed + 1) % wallets.length]!;
    return {
      transaction: { signatures: [`sig-${height}-${index}`],
        message: { accountKeys: [{ pubkey: a, signer: true, writable: true }, { pubkey: b, signer: false, writable: true }] } },
      meta: { err: null, fee: 5000 }
    };
  });
  return { chain, height, hash: `h${height}`, parentHeight: height - 1, parentHash: `h${height - 1}`,
    raw: { blockTime: 1_700_000_000, transactions } };
}

/** Deterministic source: no provider involved, so the harness is repeatable. */
function source(): BlockSource {
  let cursor = start;
  return {
    chain,
    verifyNetwork: async () => {},
    finalizedHeight: async () => start + BATCHES * BLOCKS,
    firstAvailableHeight: async () => 0,
    heights: async (from: number) => Array.from({ length: BLOCKS }, (_, i) => from + i),
    block: async (height: number) => { const b = blockAt(height, height % 7); cursor = height; return b; }
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("read timed out")), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const safe = requireSafeTestDatabaseReset();
const sql = createDb(safe.databaseUrl);
try {
  await sql.unsafe("drop schema public cascade; create schema public");
  const directory = path.resolve("packages/database/migrations");
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  for (const file of files) await sql.begin(async tx => { await tx.unsafe(await readFile(path.join(directory, file), "utf8")); });

  // ---- ingestion ----
  const store = createIndexStore(sql);
  const blockSource = source();
  let rpcCalls = 0;
  let indexed = 0;
  const ingestStarted = Date.now();
  for (let batch = 0; batch < BATCHES; batch++) {
    // Same policy as the daemon: verify on the first batch, then periodically.
    const result = await indexBatch(blockSource, store, start, BLOCKS,
      { network: batch === 0, archiveFloor: batch === 0 });
    rpcCalls += result.rpcCalls;
    indexed += result.indexed;
  }
  const ingestMs = Date.now() - ingestStarted;
  assert.equal(indexed, BATCHES * BLOCKS, "every produced block is indexed");
  const [stored] = await sql`select count(*)::int as blocks from network_blocks`;
  assert.equal(stored?.blocks, indexed, "stored block count matches the cursor");
  const [txCount] = await sql`select count(*)::int as transactions from network_transactions`;

  // ---- read path under concurrency ----
  const query = createNetworkQuery(sql);
  // One hot wallet appears once per block, so reads return real rows.
  const hot = wallets[0]!;
  const latencies: number[] = [];
  let failures = 0;
  let reads = 0;
  const readStarted = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const index = reads++;
      if (index >= QUERIES) return;
      const wallet = index % 4 === 0 ? hot : wallets[index % wallets.length]!;
      const began = Date.now();
      try {
        const page = await withTimeout(query.history(chain, wallet, 25), TIMEOUT);
        if (index % 4 === 0) assert.ok(page.transactions.length > 0, "the hot wallet has history");
      } catch { failures += 1; }
      latencies.push(Date.now() - began);
    }
  }));
  const readMs = Date.now() - readStarted;
  const sorted = [...latencies].sort((a, b) => a - b);

  // ---- retention ----
  const pruneBefore = start + Math.floor(BATCHES * BLOCKS * PRUNE_FRACTION);
  const pruneStarted = Date.now();
  const pruned = await pruneIndex(sql, chain, { before: pruneBefore, batch: 100_000 });
  const pruneMs = Date.now() - pruneStarted;
  const [afterBlocks] = await sql`select count(*)::int as blocks from network_blocks`;
  const [afterTx] = await sql`select count(*)::int as transactions from network_transactions`;
  const [orphans] = await sql`select count(*)::int as rows from network_transaction_addresses a
    left join network_transactions t on t.chain = a.chain and t.tx_id = a.tx_id where t.tx_id is null`;
  assert.equal(orphans?.rows, 0, "pruning leaves no orphaned memberships");
  assert.equal(pruned.retainedFloor, pruneBefore, "the retained floor is the prune bound");
  // Re-running is a no-op, which is what makes the command safe to repeat.
  const again = await pruneIndex(sql, chain, { before: pruneBefore, batch: 100_000 });
  assert.equal(again.deletedBlocks, 0, "a repeated prune deletes nothing");
  // And the read path discloses the pruned range rather than implying absence.
  const disclosure = await query.history(chain, hot, 5);
  assert.ok(disclosure.limitations.some(line => line.includes("pruned by retention")),
    "history states the retention floor");

  console.log(JSON.stringify({
    status: "passed",
    ingestion: { blocks: indexed, batches: BATCHES, ms: ingestMs,
      blocksPerSecond: Number((indexed / (ingestMs / 1000)).toFixed(1)), rpcCalls, rpcCallsPerBlock: Number((rpcCalls / indexed).toFixed(2)),
      transactionsStored: txCount?.transactions ?? 0 },
    reads: { queries: QUERIES, concurrency: CONCURRENCY, ms: readMs, failures,
      readsPerSecond: Number((QUERIES / (readMs / 1000)).toFixed(1)),
      p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1) ?? 0 },
    retention: { before: pruneBefore, ms: pruneMs, deletedBlocks: pruned.deletedBlocks,
      deletedTransactions: pruned.deletedTransactions, deletedAddresses: pruned.deletedAddresses,
      remainingBlocks: afterBlocks?.blocks ?? 0, remainingTransactions: afterTx?.transactions ?? 0,
      blocksPerSecond: Number((pruned.deletedBlocks / Math.max(1, pruneMs / 1000)).toFixed(1)) }
  }));
} finally {
  await sql.end();
}
