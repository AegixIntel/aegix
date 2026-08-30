import type { Sql } from "../client.js";

export interface TransferRow {
  id: string;
  transaction_id: string;
  from_address: string;
  to_address: string;
  asset_type: string;
  mint: string | null;
  amount_raw: string;
  amount_normalized: string;
  transfer_type: string;
  block_time: string;
}

export interface ProgramInteractionRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  program_id: string;
  program_label: string | null;
  protocol_category: string;
  action_type: string;
  block_time: string;
}

export interface TransactionRow {
  id: string;
  signature: string;
  slot: string;
  block_time: string;
  wallet_id: string;
  success: boolean;
  fee: string;
  transaction_class: string;
  raw_provider: string | null;
  parser_version: string | null;
  created_at: string;
}

export interface WalletAnalyticsRepo {
  insertTransaction(input: {
    signature: string;
    slot: number;
    blockTime: string;
    walletId: string;
    success: boolean;
    fee: number;
    transactionClass: string;
    rawProvider: string;
    parserVersion: string;
  }): Promise<TransactionRow>;
  insertTransfers(rows: Omit<TransferRow, "id">[]): Promise<void>;
  insertProgramInteractions(rows: Omit<ProgramInteractionRow, "id">[]): Promise<void>;
  transactionsForWallet(walletId: string, limit?: number): Promise<TransactionRow[]>;
  transfersForWallet(walletId: string, limit?: number): Promise<TransferRow[]>;
  counterpartiesForWallet(walletId: string, limit?: number): Promise<{ counterparty: string; txCount: number; totalValue: number }[]>;
}

export function createWalletAnalyticsRepo(sql: Sql): WalletAnalyticsRepo {
  return {
    async insertTransaction(input) {
      const [row] = await sql<TransactionRow[]>`
        insert into transactions (
          signature, slot, block_time, wallet_id, success, fee, transaction_class, raw_provider, parser_version
        ) values (
          ${input.signature}, ${input.slot}, ${input.blockTime}, ${input.walletId},
          ${input.success}, ${input.fee}, ${input.transactionClass}, ${input.rawProvider}, ${input.parserVersion}
        )
        on conflict (signature, wallet_id) do nothing
        returning *
      `;
      // on conflict do nothing returns no row on duplicates; return null-safe fallback
      return (
        row ?? {
          id: "",
          signature: input.signature,
          slot: String(input.slot),
          block_time: input.blockTime,
          wallet_id: input.walletId,
          success: input.success,
          fee: String(input.fee),
          transaction_class: input.transactionClass,
          raw_provider: input.rawProvider,
          parser_version: input.parserVersion,
          created_at: new Date().toISOString()
        }
      );
    },

    async insertTransfers(rows) {
      if (rows.length === 0) return;
      for (const r of sanitizeRows(rows)) {
        await sql`
          insert into transfers (
            transaction_id, from_address, to_address, asset_type, mint,
            amount_raw, amount_normalized, transfer_type, block_time
          ) values (
            ${r.transaction_id}, ${r.from_address}, ${r.to_address}, ${r.asset_type}, ${r.mint},
            ${r.amount_raw}, ${r.amount_normalized}, ${r.transfer_type}, ${r.block_time}
          )
        `;
      }
    },

    async insertProgramInteractions(rows) {
      if (rows.length === 0) return;
      for (const r of sanitizeRows(rows)) {
        await sql`
          insert into program_interactions (
            wallet_id, transaction_id, program_id, program_label, protocol_category, action_type, block_time
          ) values (
            ${r.wallet_id}, ${r.transaction_id}, ${r.program_id}, ${r.program_label},
            ${r.protocol_category}, ${r.action_type}, ${r.block_time}
          )
        `;
      }
    },

    async transactionsForWallet(walletId, limit = 2000) {
      return sql<TransactionRow[]>`
        select * from transactions
        where wallet_id = ${walletId}
        order by block_time desc
        limit ${limit}
      `;
    },

    async transfersForWallet(walletId, limit = 5000) {
      return sql<TransferRow[]>`
        select t.* from transfers t
        join transactions tx on tx.id = t.transaction_id
        where tx.wallet_id = ${walletId}
        order by t.block_time desc
        limit ${limit}
      `;
    },

    async counterpartiesForWallet(walletId, limit = 1000) {
      return sql<{ counterparty: string; txCount: number; totalValue: number }[]>`
        select
          case when t.from_address = w.address then t.to_address else t.from_address end as counterparty,
          count(*)::int as "txCount",
          sum(t.amount_normalized)::float8 as "totalValue"
        from transfers t
        join wallets w on w.id = ${walletId}
        where t.from_address = w.address or t.to_address = w.address
        group by counterparty
        order by "txCount" desc
        limit ${limit}
      `;
    }
  };
}

/** postgres.js rejects undefined values; normalize them at the data boundary. */
function sanitizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value === undefined ? null : value;
    }
    return out as T;
  });
}
