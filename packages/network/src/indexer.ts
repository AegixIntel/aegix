import type { NetworkChain } from "./chains.js";
import type { EvmReceipt } from "./evm-receipts.js";

export interface IndexedBlock {
  chain: NetworkChain;
  height: number;
  hash: string;
  parentHeight: number;
  parentHash: string;
  raw: unknown;
  rawRpc?: string;
  /** EVM only: the block's checked, trimmed receipts, in transaction order. */
  receipts?: EvmReceipt[];
}
export interface BlockSource {
  chain: NetworkChain;
  /** RPC calls one `block()` makes; EVM fetches the block and its receipts. Defaults to 1. */
  callsPerBlock?: number;
  verifyNetwork(): Promise<void>;
  finalizedHeight(): Promise<number>;
  firstAvailableHeight(): Promise<number>;
  /** Produced blocks only; skipped Solana slots are omitted. */
  heights(from: number, to: number): Promise<number[]>;
  block(height: number): Promise<IndexedBlock>;
}
export interface IndexCheckpoint {
  nextHeight: number;
  lastHeight: number | null;
  lastHash: string | null;
}
export interface IndexStore {
  checkpoint(chain: NetworkChain, start: number): Promise<IndexCheckpoint>;
  /** Atomically compare checkpoint, write blocks, then advance cursor. */
  commit(chain: NetworkChain, expected: IndexCheckpoint, next: number, blocks: IndexedBlock[]): Promise<void>;
}
export function height(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid block height");
  return value;
}

/**
 * Which defensive checks this batch performs. Both are per-invocation by
 * default; a long-running daemon re-runs them periodically instead of on every
 * batch, which otherwise costs two extra provider calls per batch for an answer
 * that cannot change between adjacent heights.
 */
export interface IndexChecks {
  network?: boolean;
  archiveFloor?: boolean;
}
export interface BatchResult {
  indexed: number;
  nextHeight: number;
  finalizedHeight: number;
  /** Provider calls this batch issued; the operator's throughput budget. */
  rpcCalls: number;
}

/** Bounded work per invocation; failures leave the persistent cursor unchanged. */
export async function indexBatch(source: BlockSource, store: IndexStore, start: number,
  batchSize = 32, checks: IndexChecks = {}): Promise<BatchResult> {
  height(start);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error("Invalid batch size");
  const verifyNetwork = checks.network ?? true;
  const checkArchiveFloor = checks.archiveFloor ?? true;
  let rpcCalls = 0;
  if (verifyNetwork) { rpcCalls += 1; await source.verifyNetwork(); }
  const checkpoint = await store.checkpoint(source.chain, start);
  rpcCalls += 1;
  const finalized = height(await source.finalizedHeight());
  const from = height(checkpoint.nextHeight);
  if (from > finalized) return { indexed: 0, nextHeight: from, finalizedHeight: finalized, rpcCalls };
  if (checkArchiveFloor) {
    rpcCalls += 1;
    if (from < height(await source.firstAvailableHeight())) throw new Error("Archive history unavailable; checkpoint preserved");
  }
  const to = Math.min(finalized, height(from + batchSize - 1));
  rpcCalls += 1;
  const heights = await source.heights(from, to);
  if (!Array.isArray(heights)) throw new Error("Invalid block range");
  let previous = from - 1;
  let parentHeight = checkpoint.lastHeight;
  let parentHash = checkpoint.lastHash;
  const blocks: IndexedBlock[] = [];
  for (const slot of heights) {
    height(slot);
    if (slot < from || slot > to || slot <= previous) throw new Error("Invalid block range ordering");
    rpcCalls += source.callsPerBlock ?? 1;
    const block = await source.block(slot);
    if (block.chain !== source.chain || block.height !== slot || !block.hash || !block.parentHash) throw new Error("Invalid block identity");
    height(block.parentHeight);
    if (slot > 0 && block.parentHeight >= slot) throw new Error("Invalid block parent");
    if (parentHash !== null && (block.parentHash !== parentHash || block.parentHeight !== parentHeight)) {
      throw new Error("Finalized chain discontinuity; operator review required");
    }
    blocks.push(block);
    previous = slot;
    parentHeight = slot;
    parentHash = block.hash;
  }
  await store.commit(source.chain, checkpoint, height(to + 1), blocks);
  return { indexed: blocks.length, nextHeight: to + 1, finalizedHeight: finalized, rpcCalls };
}
