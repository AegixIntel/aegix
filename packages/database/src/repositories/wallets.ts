import type { Sql } from "../client.js";

export interface WalletRow {
  id: string;
  chain: string;
  address: string;
  first_observed_at: string | null;
  last_observed_at: string | null;
  last_analyzed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WalletRepo {
  findOrCreate(chain: string, address: string): Promise<WalletRow>;
  findById(id: string): Promise<WalletRow | null>;
  findByAddress(chain: string, address: string): Promise<WalletRow | null>;
  touch(id: string, observedAt: string): Promise<void>;
}

export function createWalletRepo(sql: Sql): WalletRepo {
  return {
    async findOrCreate(chain, address) {
      const [row] = await sql<WalletRow[]>`
        insert into wallets (chain, address)
        values (${chain}, ${address})
        on conflict (chain, address) do update set updated_at = now()
        returning *
      `;
      if (!row) throw new Error("wallet upsert returned no row");
      return row;
    },

    async findById(id) {
      const [row] = await sql<WalletRow[]>`
        select * from wallets where id = ${id}
      `;
      return row ?? null;
    },

    async findByAddress(chain, address) {
      const [row] = await sql<WalletRow[]>`
        select * from wallets where chain = ${chain} and address = ${address}
      `;
      return row ?? null;
    },

    async touch(id, observedAt) {
      await sql`
        update wallets
        set last_observed_at = ${observedAt}, updated_at = now()
        where id = ${id}
      `;
    }
  };
}
