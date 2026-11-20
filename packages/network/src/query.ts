import type postgres from "postgres";
import { CHAINS, parseChain, walletIdentity, type NetworkChain } from "./chains.js";
import { height } from "./indexer.js";
import { persistProjection } from "./projection.js";
import { walletSignals, type SignalTransfer } from "./evm-signals.js";

/** Most recent transfers read per signals request; bounds the work per call. */
export const SIGNAL_SAMPLE = 2_000;

export interface HistoryCursor { height: number; position: number }
/** Transfers order within a transaction by ordinal; the native amount is -1. */
export interface TransferCursor extends HistoryCursor { ordinal: number }

export type TransferDirection = "IN" | "OUT" | "SELF";
interface TransferRow {
  tx_id: string; ordinal: number; height: string; position: number; kind: "NATIVE" | "ERC20" | "ERC721";
  token: string | null; sender: string; recipient: string; amount_atomic: string | null; token_id: string | null;
  block_time: Date | null;
}

export function createNetworkQuery(sql: postgres.Sql) {
  /**
   * What the index covers for a chain, and whether retention removed part of
   * it. Storage is bounded by an operator retention floor; say so instead of
   * letting a pruned range read as "this wallet has no older activity". An
   * index that was populated and then fully pruned reports no floor at all,
   * which is exactly the case that must not read as "never used".
   */
  async function coverageOf(chain: NetworkChain) {
    const [coverage] = await sql`select start_height::text, next_height::text, last_height::text, finalized_height::text,
      heartbeat_at, last_error,
      (select min(height)::text from network_blocks b where b.chain = ${chain}) as retained_floor
      from network_checkpoints where chain = ${chain}`;
    const floor = coverage?.retained_floor == null ? null : Number(coverage.retained_floor);
    const indexedSomething = coverage != null && Number(coverage.next_height) > Number(coverage.start_height);
    const pruned = indexedSomething && (floor === null || floor > Number(coverage!.start_height));
    const retention = pruned ? [floor === null
      ? "Every indexed block has been pruned by retention; history is unavailable."
      : `Blocks below height ${floor} were pruned by retention; earlier history is unavailable.`] : [];
    return { coverage: coverage ?? null, retention };
  }
  function canonicalAddress(chain: NetworkChain, address: string, limit: number) {
    walletIdentity(chain, address);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid history limit");
    return CHAINS[chain].family === "evm" ? address.toLowerCase() : address;
  }

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
      const canonical = canonicalAddress(chain, address, limit);
      if (before) { height(before.height); height(before.position); }
      const cursor = before ? sql`and (a.height, a.position) < (${before.height}, ${before.position})` : sql``;
      const rows = await sql`select t.tx_id, t.height::text, t.position, t.block_time, t.success,
        t.sender, t.recipient, t.value_atomic from network_transaction_addresses a
        join network_transactions t on t.chain = a.chain and t.tx_id = a.tx_id
        where a.chain = ${chain} and a.address = ${canonical} ${cursor}
        order by a.height desc, a.position desc limit ${limit + 1}`;
      const more = rows.length > limit;
      const transactions = rows.slice(0, limit);
      const last = transactions.at(-1);
      const { coverage, retention } = await coverageOf(chain);
      return { wallet: walletIdentity(chain, address), coverage, transactions,
        nextCursor: more && last ? { height: Number(last.height), position: Number(last.position) } : null,
        limitations: ["History covers the indexed range only.", ...retention,
          "Address involvement does not establish ownership.",
          ...(CHAINS[chain].family === "evm" ? ["Execution comes from each block's receipts; a transaction indexed without a receipt shows success as unknown.",
            "Value is the native amount the transaction sent; a reverted transaction moved nothing.",
            "A transaction is listed when the wallet sent it, was its recipient, or was a party to an ERC-20 or ERC-721 transfer in it.",
            "Internal calls are not included."] : [])] };
    },
    /**
     * Native and token transfers where the wallet is sender or recipient,
     * newest first. EVM only: Solana transfers are not decoded by this index.
     */
    async transfers(chain: NetworkChain, address: string, limit = 50, before?: TransferCursor) {
      if (CHAINS[chain].family !== "evm") throw new Error("Transfers are recorded for EVM chains only");
      const canonical = canonicalAddress(chain, address, limit);
      if (before) {
        height(before.height); height(before.position);
        if (!Number.isSafeInteger(before.ordinal) || before.ordinal < -1) throw new Error("Invalid transfer cursor");
      }
      const cursor = before ? sql`and (height, position, ordinal) < (${before.height}, ${before.position}, ${before.ordinal})` : sql``;
      // One index walk per side, each bounded, merged. UNION removes the
      // duplicate a self-transfer would produce.
      const side = (column: "sender" | "recipient") => sql`(select tx_id, ordinal, height, position, kind, token, sender,
        recipient, amount_atomic, token_id from network_transfers
        where chain = ${chain} and ${sql(column)} = ${canonical} ${cursor}
        order by height desc, position desc, ordinal desc limit ${limit + 1})`;
      const rows = await sql<TransferRow[]>`select x.tx_id, x.ordinal, x.height::text, x.position, x.kind, x.token, x.sender, x.recipient,
        x.amount_atomic, x.token_id, t.block_time
        from (${side("sender")} union ${side("recipient")}) x
        join network_transactions t on t.chain = ${chain} and t.tx_id = x.tx_id
        order by x.height desc, x.position desc, x.ordinal desc limit ${limit + 1}`;
      const more = rows.length > limit;
      const transfers = rows.slice(0, limit).map(row => ({ ...row,
        direction: (row.sender === row.recipient ? "SELF" : row.sender === canonical ? "OUT" : "IN") as TransferDirection }));
      const last = transfers.at(-1);
      const { coverage, retention } = await coverageOf(chain);
      return { wallet: walletIdentity(chain, address), coverage, transfers,
        nextCursor: more && last ? { height: Number(last.height), position: Number(last.position), ordinal: Number(last.ordinal) } : null,
        limitations: ["Transfers cover the indexed range only.", ...retention,
          "Only successful transactions are read; a reverted transaction moved nothing.",
          "Native transfers are the amount a transaction sent directly; value moved by internal calls is not included.",
          "Token transfers are ERC-20 and ERC-721 Transfer events. Any contract can emit one, so the token contract is not verified, and amounts are in the token's smallest unit.",
          "ERC-1155 and other token standards are not included.",
          "Zero-amount transfers and look-alike addresses are common in address poisoning; an incoming transfer does not show that the wallet chose to transact."] };
    },
    /**
     * Counterparties, earliest funding and look-alike addresses, read from the
     * wallet's most recent transfers in the indexed window. No score.
     */
    async signals(chain: NetworkChain, address: string) {
      if (CHAINS[chain].family !== "evm") throw new Error("Signals are computed for EVM chains only");
      const canonical = canonicalAddress(chain, address, 1);
      const cap = SIGNAL_SAMPLE;
      const side = (column: "sender" | "recipient") => sql`(select tx_id, ordinal, height, position, kind, token, sender,
        recipient, amount_atomic from network_transfers where chain = ${chain} and ${sql(column)} = ${canonical}
        order by height desc, position desc, ordinal desc limit ${cap + 1})`;
      const rows = await sql<Array<Omit<SignalTransfer, "height"> & { height: string }>>`select x.tx_id, x.ordinal, x.height::text,
        x.kind, x.token, x.sender, x.recipient, x.amount_atomic, t.sender as tx_sender
        from (${side("sender")} union ${side("recipient")}) x
        join network_transactions t on t.chain = ${chain} and t.tx_id = x.tx_id
        order by x.height desc, x.position desc, x.ordinal desc limit ${cap + 1}`;
      const truncated = rows.length > cap;
      const sample = rows.slice(0, cap).map(row => ({ ...row, height: Number(row.height) }));
      const { coverage, retention } = await coverageOf(chain);
      return { wallet: walletIdentity(chain, address), coverage, ...walletSignals(canonical, sample, truncated),
        limitations: ["Signals cover the indexed range only and describe observed transfers, not intent or ownership.", ...retention,
          ...(truncated ? [`Only the most recent ${cap} transfers were read.`] : []),
          "There is no risk score. Each signal can be checked against the listed transfers.",
          "Earliest funding is the earliest incoming native transfer in the indexed range, not necessarily the wallet's first.",
          "A look-alike shares its first and last four characters with an address this wallet sent value to in a transaction it signed. It is a reason to double-check an address before copying it, not proof of an attack.",
          "Internal calls and ERC-1155 are not included."] };
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
