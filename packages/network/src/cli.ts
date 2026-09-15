import postgres from "postgres";
import { parseChain } from "./chains.js";
import { height } from "./indexer.js";
import { createBlockSource, createRpc } from "./rpc.js";
import { createIndexStore } from "./store.js";
import { runIndexer } from "./runner.js";
import { createNetworkQuery } from "./query.js";

/** Explicit --follow enables continuous ingestion; default remains one batch. */
async function main() {
  const { INDEXER_CHAIN, INDEXER_RPC_URL, INDEXER_START_HEIGHT, INDEXER_BATCH_SIZE, DATABASE_URL } = process.env;
  if (!INDEXER_CHAIN || !INDEXER_RPC_URL || !INDEXER_START_HEIGHT || !DATABASE_URL) {
    throw new Error("Set INDEXER_CHAIN, INDEXER_RPC_URL, INDEXER_START_HEIGHT and DATABASE_URL");
  }
  const chain = parseChain(INDEXER_CHAIN);
  const start = height(Number(INDEXER_START_HEIGHT));
  const batch = INDEXER_BATCH_SIZE === undefined ? 32 : Number(INDEXER_BATCH_SIZE);
  const pollMs = Number(process.env.INDEXER_POLL_MS ?? 2000);
  if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error("Invalid poll interval");
  const sql = postgres(DATABASE_URL, { max: 2, connect_timeout: 10 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (process.argv.includes("--backfill")) {
      console.log(JSON.stringify({ projected: await createNetworkQuery(sql).backfill(chain) }));
      return;
    }
    await runIndexer({ source: createBlockSource(chain, createRpc(INDEXER_RPC_URL)), store: createIndexStore(sql),
      sql, start, batchSize: batch, signal: controller.signal, once: !process.argv.includes("--follow"), pollMs,
      log: event => console.log(JSON.stringify(event)) });
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
