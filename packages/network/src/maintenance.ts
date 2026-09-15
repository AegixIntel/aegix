import type postgres from "postgres";
import type { NetworkChain } from "./chains.js";
import { height } from "./indexer.js";

export interface PruneOptions {
  /** Exclusive upper bound: blocks strictly below this height are removed. */
  before: number;
  /** Blocks removed per invocation, so locks stay short. */
  batch?: number;
}
export interface PruneResult {
  chain: NetworkChain;
  before: number;
  deletedBlocks: number;
  deletedTransactions: number;
  deletedAddresses: number;
  deletedProjections: number;
  /** Lowest height still retained, or null when nothing is left. */
  retainedFloor: number | null;
  done: boolean;
}

/**
 * Removes indexed blocks below a height. Projections, transactions and address
 * memberships follow, because they reference the block rows.
 *
 * This is the storage lever: a finalized Solana block is megabytes, so an
 * unbounded archive is not a viable default. It is deliberately operator-driven
 * and destructive — wallet history below the floor is gone — so it refuses to
 * run above the indexed cursor and reports the floor it leaves behind.
 *
 * Each call prunes one bounded batch inside one transaction and takes the same
 * row lock as ingestion, so it never races a committing batch. Re-running it is
 * a no-op once nothing remains below the bound.
 */
export async function pruneIndex(sql: postgres.Sql, chain: NetworkChain, options: PruneOptions): Promise<PruneResult> {
  const before = height(options.before);
  const batch = options.batch ?? 5_000;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 100_000) throw new Error("Invalid prune batch");
  return sql.begin(async tx => {
    const [checkpoint] = await tx`select next_height from network_checkpoints where chain = ${chain} for update`;
    if (!checkpoint) throw new Error("Missing index checkpoint");
    // Blocks at or above the cursor do not exist yet; a bound above it is a mistake.
    if (before > Number(checkpoint.next_height)) throw new Error("Refusing to prune above the indexed cursor");

    const selected = await tx`select height::text as height from network_blocks
      where chain = ${chain} and height < ${before} order by height limit ${batch}`;
    if (!selected.length) {
      return { chain, before, deletedBlocks: 0, deletedTransactions: 0, deletedAddresses: 0,
        deletedProjections: 0, retainedFloor: await floorOf(tx, chain), done: true };
    }
    const heights = selected.map(row => Number(row.height));
    // Children first: they hold foreign keys onto the block rows.
    const addresses = await tx`delete from network_transaction_addresses a using network_transactions t
      where a.chain = t.chain and a.tx_id = t.tx_id and t.chain = ${chain} and t.height = any(${heights}::bigint[])`;
    const transactions = await tx`delete from network_transactions
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    const projections = await tx`delete from network_projections
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    const blocks = await tx`delete from network_blocks
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    return {
      chain, before,
      deletedBlocks: blocks.count, deletedTransactions: transactions.count,
      deletedAddresses: addresses.count, deletedProjections: projections.count,
      retainedFloor: await floorOf(tx, chain),
      done: selected.length < batch
    };
  });
}

async function floorOf(tx: postgres.TransactionSql, chain: NetworkChain): Promise<number | null> {
  const [row] = await tx`select min(height)::text as height from network_blocks where chain = ${chain}`;
  return row?.height === null || row?.height === undefined ? null : Number(row.height);
}
