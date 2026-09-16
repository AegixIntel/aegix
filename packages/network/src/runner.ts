import { setTimeout as sleep } from "node:timers/promises";
import type postgres from "postgres";
import { indexBatch, type BlockSource, type IndexStore } from "./indexer.js";
import { RpcRequestError, RpcUnavailableError, type RpcPoolStats } from "./rpc.js";

/**
 * A failure category an operator can act on: retry a throttle, raise a timeout,
 * check archive coverage for a provider rejection. Deliberately a fixed set —
 * provider messages are not recorded because they can carry the endpoint URL.
 */
function failureDetail(error: unknown): Record<string, unknown> {
  if (error instanceof RpcUnavailableError) {
    return { reason: error.reason, ...(error.status === undefined ? {} : { status: error.status }) };
  }
  if (error instanceof RpcRequestError && typeof error.rpcCode === "number") return { rpcCode: error.rpcCode };
  // A database failure carries a SQLSTATE and nothing else an operator can act
  // on: the driver's message may quote the row being written, so the code is
  // recorded and the message is not.
  const sqlState = (error as { code?: unknown } | null)?.code;
  if (typeof sqlState === "string" && /^[0-9A-Z]{5}$/.test(sqlState)) return { sqlState };
  return {};
}

export interface IndexerOptions {
  source: BlockSource;
  store: IndexStore;
  sql: postgres.Sql;
  start: number;
  batchSize: number;
  signal: AbortSignal;
  once: boolean;
  pollMs: number;
  log: (event: Record<string, unknown>) => void;
  /**
   * How often to re-run the network identity and archive-floor checks in a
   * long-running process. They are always re-run on the first batch and after
   * any failure; between those, repeating them every batch only spends provider
   * calls on an answer that cannot change from one height to the next.
   */
  verificationIntervalBatches?: number;
  /** Provider pool counters, included in the batch log line when supplied. */
  rpcStats?: () => RpcPoolStats;
}

/** One batch at a time, persisted health, bounded retries and graceful draining. */
export async function runIndexer(options: IndexerOptions) {
  const { source, store, sql, signal, log } = options;
  const interval = options.verificationIntervalBatches ?? 60;
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error("Invalid verification interval");
  let failures = 0;
  let batches = 0;
  let indexed = 0;
  while (!signal.aborted) {
    const startedAt = Date.now();
    let delay = options.pollMs;
    try {
      const result = await indexBatch(source, store, options.start, options.batchSize, {
        network: batches === 0 || failures > 0 || batches % interval === 0,
        archiveFloor: batches === 0 || failures > 0 || batches % interval === 0
      });
      batches += 1;
      indexed += result.indexed;
      await sql`update network_checkpoints set finalized_height = ${result.finalizedHeight},
        heartbeat_at = now(), last_error = null where chain = ${source.chain}`;
      log({ event: "indexed", chain: source.chain, ...result, batches, indexedTotal: indexed,
        behind: Math.max(0, result.finalizedHeight - (result.nextHeight - 1)),
        durationMs: Date.now() - startedAt, ...(options.rpcStats ? { rpc: options.rpcStats() } : {}) });
      failures = 0;
      if (options.once) return;
    } catch (error) {
      failures += 1;
      // Never persist driver/RPC messages containing endpoint credentials.
      const code = "INDEX_BATCH_FAILED";
      await sql`update network_checkpoints set heartbeat_at = now(), last_error = ${code}
        where chain = ${source.chain}`.catch(() => {});
      log({ event: "index_error", chain: source.chain, code, attempt: failures,
        kind: error instanceof Error ? error.name : "Unknown", ...failureDetail(error),
        durationMs: Date.now() - startedAt });
      if (options.once) throw new Error(code);
      delay = Math.min(60_000, options.pollMs * 2 ** Math.min(failures, 6));
    }
    await sleep(delay, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
}
