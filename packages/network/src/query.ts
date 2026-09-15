import type postgres from "postgres";
import { CHAINS, parseChain, walletIdentity, type NetworkChain } from "./chains.js";
import { height } from "./indexer.js";
import { persistProjection } from "./projection.js";

export interface HistoryCursor { height: number; position: number }
export function createNetworkQuery(sql: postgres.Sql) {
  return {
    async status() {
      const rows = await sql`select chain, start_height::text, next_height::text, last_height::text,
        finalized_height::text, updated_at, heartbeat_at, last_error,
        (select min(height)::text from network_blocks b where b.chain = network_checkpoints.chain) as retained_floor
        from network_checkpoints`;
      return Object.entries(CHAINS).map(([chain, capabilities]) => ({ chain, ...capabilities,
        coverage: rows.find(row => row.chain === chain) ?? null }));
    },
    async history(chain: NetworkChain, address: string, limit = 50, before?: HistoryCursor) {
      walletIdentity(chain, address);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid history limit");
      if (before) { height(before.height); height(before.position); }
      const canonical = CHAINS[chain].family === "evm" ? address.toLowerCase() : address;
      const cursor = before ? sql`and (a.height, a.position) < (${before.height}, ${before.position})` : sql``;
      const rows = await sql`select t.tx_id, t.height::text, t.position, t.block_time, t.success,
        t.sender, t.recipient, t.value_atomic from network_transaction_addresses a
        join network_transactions t on t.chain = a.chain and t.tx_id = a.tx_id
        where a.chain = ${chain} and a.address = ${canonical} ${cursor}
        order by a.height desc, a.position desc limit ${limit + 1}`;
      const more = rows.length > limit;
      const transactions = rows.slice(0, limit);
      const last = transactions.at(-1);
      const [coverage] = await sql`select start_height::text, next_height::text, last_height::text, finalized_height::text,
        heartbeat_at, last_error,
        (select min(height)::text from network_blocks b where b.chain = ${chain}) as retained_floor
        from network_checkpoints where chain = ${chain}`;
      // Storage is bounded by an operator retention floor; say so instead of
      // letting a pruned range read as "this wallet has no older activity". An
      // index that was populated and then fully pruned reports no floor at all,
      // which is exactly the case that must not read as "never used".
      const floor = coverage?.retained_floor == null ? null : Number(coverage.retained_floor);
      const indexedSomething = coverage != null && Number(coverage.next_height) > Number(coverage.start_height);
      const pruned = indexedSomething && (floor === null || floor > Number(coverage!.start_height));
      return { wallet: walletIdentity(chain, address), coverage: coverage ?? null, transactions,
        nextCursor: more && last ? { height: Number(last.height), position: Number(last.position) } : null,
        limitations: ["History covers the indexed range only.",
          ...(pruned ? [floor === null
            ? "Every indexed block has been pruned by retention; history is unavailable."
            : `Blocks below height ${floor} were pruned by retention; earlier history is unavailable.`] : []),
          "Address involvement does not establish ownership.",
          ...(CHAINS[chain].family === "evm" ? ["EVM success is unknown without receipts; value is the requested native amount, not a confirmed transfer.", "Internal calls and token logs are not included."] : [])] };
    },
    async transaction(chain: NetworkChain, id: string) {
      parseChain(chain);
      const [row] = await sql`select raw from network_transactions where chain = ${chain} and tx_id = ${id}`;
      return row?.raw ?? null;
    },
    async backfill(chain: NetworkChain, limit = 16) {
      parseChain(chain);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid backfill limit");
      return sql.begin(async tx => {
        // Same lock as ingestion serializes projection maintenance with new batches.
        await tx`select chain from network_checkpoints where chain = ${chain} for update`;
        const blocks = await tx`select b.* from network_blocks b left join network_projections p
          on p.chain = b.chain and p.height = b.height where b.chain = ${chain} and p.height is null
          order by b.height limit ${limit}`;
        for (const b of blocks) await persistProjection(tx, { chain, height: Number(b.height), hash: b.hash,
          parentHeight: Number(b.parent_height), parentHash: b.parent_hash, raw: b.raw });
        return blocks.length;
      });
    }
  };
}
