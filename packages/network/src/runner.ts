import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { indexBatch, type BlockSource, type IndexStore } from "./indexer.js";

/** One batch at a time, persisted health, bounded retries and graceful draining. */
export async function runIndexer(options: {
  source: BlockSource; store: IndexStore; sql: postgres.Sql; start: number; batchSize: number;
  signal: AbortSignal; once: boolean; pollMs: number; log: (event: Record<string, unknown>) => void;
}) {
  const { source, store, sql, signal, log } = options;
  let failures = 0;
  while (!signal.aborted) {
    let delay = options.pollMs;
    try {
      const result = await indexBatch(source, store, options.start, options.batchSize);
      await sql`update network_checkpoints set finalized_height = ${result.finalizedHeight},
        heartbeat_at = now(), last_error = null where chain = ${source.chain}`;
      log({ event: "indexed", chain: source.chain, ...result });
      failures = 0;
      if (options.once) return;
    } catch {
      failures++;
      // Never persist driver/RPC messages containing endpoint credentials.
      const code = "INDEX_BATCH_FAILED";
      await sql`update network_checkpoints set heartbeat_at = now(), last_error = ${code}
        where chain = ${source.chain}`.catch(() => {});
      log({ event: "index_error", chain: source.chain, code, attempt: failures });
      if (options.once) throw new Error(code);
      delay = Math.min(60_000, options.pollMs * 2 ** Math.min(failures, 6));
    }
    await sleep(delay, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
}
