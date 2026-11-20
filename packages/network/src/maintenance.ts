import type postgres from "postgres";
import type { NetworkChain } from "./chains.js";
import { height } from "./indexer.js";

export interface PruneOptions {
  /** Exclusive upper bound: blocks strictly below this height are removed. */
  before: number;
  /** Maximum blocks considered per invocation. */
  batch?: number;
  /**
   * Maximum child rows removed per invocation. Blocks are not uniform — a busy
   * Solana block carries tens of thousands of address memberships — so a bound
   * expressed only in blocks can still turn into an unbounded transaction.
   */
  rowBudget?: number;
}
export interface PruneResult {
  chain: NetworkChain;
  before: number;
  deletedBlocks: number;
  deletedTransactions: number;
  deletedAddresses: number;
  deletedTransfers: number;
  deletedProjections: number;
  /** Lowest height still retained, or null when nothing is left. */
  retainedFloor: number | null;
  done: boolean;
}

/**
 * Removes indexed blocks below a height. Projections, transactions, transfers and address
 * memberships follow, because they reference the block rows.
 *
 * This is the storage lever: a finalized Solana block is megabytes, so an
 * unbounded archive is not a viable default. It is deliberately operator-driven
 * and destructive — wallet history below the floor is gone — so it refuses to
 * run above the indexed cursor and reports the floor it leaves behind.
 *
 * Retention and ingestion do not overlap: ingestion only appends at or above the
 * cursor, while this only removes strictly below the bound, so no row lock on the
 * checkpoint is taken and a prune cannot stall a running indexer. Work is bounded
 * per invocation by both a block count and a row budget, and deleting by height
 * relies on the indexes added in migration 0014 — without them the same delete
 * degrades into a sequential scan per removed parent row. Re-running is a no-op
 * once nothing below the bound remains.
 */
export async function pruneIndex(sql: postgres.Sql, chain: NetworkChain, options: PruneOptions): Promise<PruneResult> {
  const before = height(options.before);
  const batch = options.batch ?? 64;
  const rowBudget = options.rowBudget ?? 50_000;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 10_000) throw new Error("Invalid prune batch");
  if (!Number.isSafeInteger(rowBudget) || rowBudget < 1 || rowBudget > 5_000_000) throw new Error("Invalid prune row budget");
  return sql.begin(async tx => {
    const [checkpoint] = await tx`select next_height from network_checkpoints where chain = ${chain}`;
    if (!checkpoint) throw new Error("Missing index checkpoint");
    // Blocks at or above the cursor do not exist yet; a bound above it is a mistake.
    if (before > Number(checkpoint.next_height)) throw new Error("Refusing to prune above the indexed cursor");

    const candidates = await tx`select b.height::text as height,
      ((select count(*) from network_transaction_addresses a where a.chain = b.chain and a.height = b.height)
        + (select count(*) from network_transfers t where t.chain = b.chain and t.height = b.height))::int as rows
      from network_blocks b where b.chain = ${chain} and b.height < ${before}
      order by b.height limit ${batch}`;
    if (!candidates.length) {
      return { chain, before, deletedBlocks: 0, deletedTransactions: 0, deletedAddresses: 0,
        deletedTransfers: 0, deletedProjections: 0, retainedFloor: await floorOf(tx, chain), done: true };
    }
    const heights: number[] = [];
    let rows = 0;
    for (const candidate of candidates) {
      heights.push(Number(candidate.height));
      rows += candidate.rows;
      if (rows >= rowBudget) break; // Always keeps at least one block, so progress is guaranteed.
    }
    const done = candidates.length < batch && heights.length === candidates.length;
    // Children first: they hold foreign keys onto the block rows. Deleting by
    // height uses the 0014 indexes instead of a scan per parent row.
    const addresses = await tx`delete from network_transaction_addresses
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    const transfers = await tx`delete from network_transfers
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    const transactions = await tx`delete from network_transactions
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    const projections = await tx`delete from network_projections
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    const blocks = await tx`delete from network_blocks
      where chain = ${chain} and height = any(${heights}::bigint[])`;
    return {
      chain, before,
      deletedBlocks: blocks.count, deletedTransactions: transactions.count,
      deletedAddresses: addresses.count, deletedTransfers: transfers.count, deletedProjections: projections.count,
      retainedFloor: await floorOf(tx, chain),
      done
    };
  });
}

async function floorOf(tx: postgres.TransactionSql, chain: NetworkChain): Promise<number | null> {
  const [row] = await tx`select min(height)::text as height from network_blocks where chain = ${chain}`;
  return row?.height === null || row?.height === undefined ? null : Number(row.height);
}
