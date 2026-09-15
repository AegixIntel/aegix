import postgres from "postgres";
import { parseChain } from "./chains.js";
import { height } from "./indexer.js";
import { createBlockSource, createRpcPool } from "./rpc.js";
import { createIndexStore } from "./store.js";
import { runIndexer } from "./runner.js";
import { createNetworkQuery } from "./query.js";

function bounded(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${name}`);
  return parsed;
}

/** Comma-separated INDEXER_RPC_URLS wins; INDEXER_RPC_URL stays the single-endpoint form. */
function endpoints(): string[] {
  const list = (process.env.INDEXER_RPC_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (list.length) return list;
  if (process.env.INDEXER_RPC_URL) return [process.env.INDEXER_RPC_URL];
  throw new Error("Set INDEXER_RPC_URLS or INDEXER_RPC_URL");
}

/** Explicit --follow enables continuous ingestion; default remains one batch. */
async function main() {
  const { INDEXER_CHAIN, INDEXER_START_HEIGHT, DATABASE_URL } = process.env;
  if (!INDEXER_CHAIN || !INDEXER_START_HEIGHT || !DATABASE_URL) {
    throw new Error("Set INDEXER_CHAIN, INDEXER_START_HEIGHT and DATABASE_URL");
  }
  const urls = endpoints();
  const chain = parseChain(INDEXER_CHAIN);
  const start = height(Number(INDEXER_START_HEIGHT));
  const batch = bounded(process.env.INDEXER_BATCH_SIZE, 32, 1, 256, "batch size");
  const pollMs = bounded(process.env.INDEXER_POLL_MS, 2000, 250, 60_000, "poll interval");
  const pool = createRpcPool(urls, {
    minimumIntervalMs: bounded(process.env.INDEXER_RPC_MIN_INTERVAL_MS, 200, 0, 60_000, "RPC interval"),
    timeoutMs: bounded(process.env.INDEXER_RPC_TIMEOUT_MS, 30_000, 1000, 300_000, "RPC timeout"),
    maxAttempts: bounded(process.env.INDEXER_RPC_MAX_ATTEMPTS, Math.max(1, urls.length), 1, 10, "RPC attempts"),
    cooldownMs: bounded(process.env.INDEXER_RPC_COOLDOWN_MS, 30_000, 1000, 600_000, "RPC cooldown")
  });
  const verificationIntervalBatches = bounded(process.env.INDEXER_VERIFY_EVERY_BATCHES, 60, 1, 10_000, "verification interval");
  const sql = postgres(DATABASE_URL, { max: 2, connect_timeout: 10 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // Endpoint count, never the endpoints: provider URLs carry API keys.
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ ...event, rpcEndpoints: pool.endpointCount }));
  try {
    if (process.argv.includes("--backfill")) {
      console.log(JSON.stringify({ projected: await createNetworkQuery(sql).backfill(chain) }));
      return;
    }
    await runIndexer({ source: createBlockSource(chain, pool.call), store: createIndexStore(sql),
      sql, start, batchSize: batch, signal: controller.signal, once: !process.argv.includes("--follow"), pollMs,
      verificationIntervalBatches, rpcStats: pool.stats, log });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await sql.end();
  }
}
main().catch(() => {
  // Drivers may include connection credentials in errors. Keep CLI output safe.
  console.error("Indexer batch failed; verify configuration, archive availability and checkpoint continuity.");
  process.exitCode = 1;
});
