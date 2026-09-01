import type { Sql } from "../client.js";

export interface SavedComparisonRow {
  id: string;
  user_id: string;
  pair_key: string;
  wallet_a: string;
  wallet_b: string;
  comparison_result_id: string | null;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  /** Joined snapshot metadata for the dashboard/list (historical result reuse). */
  correlation_score: number | null;
  confidence: string | null;
  classification: string | null;
  engine_version: string | null;
  result_created_at: string | null;
}

export interface SavedComparisonRepo {
  /** Idempotent upsert: one saved comparison per (user, canonical pair). */
  save(input: {
    userId: string;
    pairKey: string;
    walletA: string;
    walletB: string;
    comparisonResultId: string | null;
    label: string | null;
    notes: string | null;
  }): Promise<SavedComparisonRow>;
  listForUser(userId: string, opts: { limit: number; offset: number; sort: "created_at" | "updated_at" | "last_opened_at"; order: "desc" | "asc" }): Promise<SavedComparisonRow[]>;
  getForUser(userId: string, id: string): Promise<SavedComparisonRow | null>;
  updateForUser(userId: string, id: string, patch: { label?: string | null; notes?: string | null }): Promise<SavedComparisonRow | null>;
  deleteForUser(userId: string, id: string): Promise<boolean>;
  touchOpenedForUser(userId: string, id: string): Promise<void>;
}

const LIST_COLUMNS = `
  sc.id::text, sc.user_id::text, sc.pair_key, sc.wallet_a, sc.wallet_b,
  sc.comparison_result_id::text, sc.label, sc.notes, sc.created_at,
  sc.updated_at, sc.last_opened_at,
  cr.correlation_score, cr.confidence::text as confidence, cr.classification,
  cr.engine_version, cr.created_at as result_created_at
`;

/** Saved comparisons repository, see docs/d6-block1.md (D6-A). */
export function createSavedComparisonRepo(sql: Sql): SavedComparisonRepo {
  return {
    async save(input) {
      const [row] = await sql<SavedComparisonRow[]>`
        insert into saved_comparisons (user_id, pair_key, wallet_a, wallet_b, comparison_result_id, label, notes)
        values (${input.userId}, ${input.pairKey}, ${input.walletA}, ${input.walletB}, ${input.comparisonResultId}, ${input.label}, ${input.notes})
        on conflict (user_id, pair_key) do update set
          label = coalesce(excluded.label, saved_comparisons.label),
          notes = coalesce(excluded.notes, saved_comparisons.notes),
          comparison_result_id = coalesce(excluded.comparison_result_id, saved_comparisons.comparison_result_id),
          updated_at = now(),
          created_at = saved_comparisons.created_at
        returning id::text, user_id::text, pair_key, wallet_a, wallet_b,
          comparison_result_id::text, label, notes, created_at,
          updated_at, last_opened_at,
          null::integer as correlation_score, null::text as confidence,
          null::text as classification, null::text as engine_version,
          null::timestamptz as result_created_at
      `;
      if (!row) throw new Error("saved comparison upsert returned no row");
      return row;
    },

    async listForUser(userId, opts) {
      const sortCol = opts.sort === "updated_at" ? "sc.updated_at" : opts.sort === "last_opened_at" ? "sc.last_opened_at" : "sc.created_at";
      const order = opts.order === "asc" ? "asc" : "desc";
      return sql<SavedComparisonRow[]>`
        select ${sql.unsafe(LIST_COLUMNS)}
        from saved_comparisons sc
        left join correlation_results cr on cr.id = sc.comparison_result_id
        where sc.user_id = ${userId}
        order by ${sql.unsafe(sortCol)} ${sql.unsafe(order)}, sc.id desc
        limit ${opts.limit} offset ${opts.offset}
      `;
    },

    async getForUser(userId, id) {
      const [row] = await sql<SavedComparisonRow[]>`
        select ${sql.unsafe(LIST_COLUMNS)}
        from saved_comparisons sc
        left join correlation_results cr on cr.id = sc.comparison_result_id
        where sc.user_id = ${userId} and sc.id = ${id}
        limit 1
      `;
      return row ?? null;
    },

    async updateForUser(userId, id, patch) {
      const [row] = await sql<SavedComparisonRow[]>`
        update saved_comparisons
        set label = ${patch.label ?? null}, notes = ${patch.notes ?? null}, updated_at = now()
        where user_id = ${userId} and id = ${id}
        returning id::text, user_id::text, pair_key, wallet_a, wallet_b,
          comparison_result_id::text, label, notes, created_at,
          updated_at, last_opened_at,
          null::integer as correlation_score, null::text as confidence,
          null::text as classification, null::text as engine_version,
          null::timestamptz as result_created_at
      `;
      return row ?? null;
    },

    async deleteForUser(userId, id) {
      const result = await sql`
        delete from saved_comparisons
        where user_id = ${userId} and id = ${id}
      `;
      return result.count > 0;
    },

    async touchOpenedForUser(userId, id) {
      await sql`
        update saved_comparisons
        set last_opened_at = now()
        where user_id = ${userId} and id = ${id}
      `;
    }
  };
}
