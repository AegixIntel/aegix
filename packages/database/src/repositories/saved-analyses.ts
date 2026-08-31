import type { Sql } from "../client.js";

export interface SavedAnalysisRow {
  id: string;
  user_id: string;
  wallet_id: string;
  wallet_address: string;
  analysis_id: string | null;
  label: string | null;
  created_at: string;
  /** Joined from the latest READY analysis, when present. */
  score: number | null;
  confidence: number | null;
  status: string | null;
  last_analyzed_at: string | null;
  fresh_until: string | null;
}

export interface SavedAnalysisRepo {
  save(input: { userId: string; walletId: string; analysisId: string | null; label: string | null }): Promise<SavedAnalysisRow>;
  listForUser(userId: string): Promise<SavedAnalysisRow[]>;
  deleteForUser(userId: string, walletId: string): Promise<boolean>;
  getForUser(userId: string, walletId: string): Promise<SavedAnalysisRow | null>;
}

/** Saved analysis repository, see milestone D3-G §38. */
export function createSavedAnalysisRepo(sql: Sql): SavedAnalysisRepo {
  return {
    async save(input) {
      const [row] = await sql<SavedAnalysisRow[]>`
        insert into saved_analyses (user_id, wallet_id, analysis_id, label)
        values (${input.userId}, ${input.walletId}, ${input.analysisId}, ${input.label})
        on conflict (user_id, wallet_id) do update set
          label = excluded.label,
          analysis_id = coalesce(excluded.analysis_id, saved_analyses.analysis_id),
          created_at = saved_analyses.created_at
        returning id::text, user_id::text, wallet_id::text, analysis_id::text, label, created_at
      `;
      if (!row) throw new Error("saved analysis upsert returned no row");
      return row;
    },

    async listForUser(userId) {
      return sql<SavedAnalysisRow[]>`
        select
          sa.id::text,
          sa.user_id::text,
          sa.wallet_id::text,
          w.address as wallet_address,
          sa.analysis_id::text,
          sa.label,
          sa.created_at,
          es.overall_score as score,
          es.overall_confidence as confidence,
          aj.status,
          aj.completed_at as last_analyzed_at,
          aj.fresh_until
        from saved_analyses sa
        join wallets w on w.id = sa.wallet_id
        left join lateral (
          select aj2.id, aj2.status, aj2.completed_at, aj2.fresh_until
          from analysis_jobs aj2
          where aj2.wallet_id = sa.wallet_id and aj2.status = 'READY'
          order by aj2.created_at desc
          limit 1
        ) aj on true
        left join exposure_scores es on es.analysis_id = aj.id
        where sa.user_id = ${userId}
        order by sa.created_at desc
      `;
    },

    async deleteForUser(userId, walletId) {
      const result = await sql`
        delete from saved_analyses
        where user_id = ${userId} and wallet_id = ${walletId}
      `;
      return result.count > 0;
    },

    async getForUser(userId, walletId) {
      const [row] = await sql<SavedAnalysisRow[]>`
        select
          sa.id::text, sa.user_id::text, sa.wallet_id::text,
          w.address as wallet_address, sa.analysis_id::text, sa.label, sa.created_at,
          es.overall_score as score, es.overall_confidence as confidence,
          aj.status, aj.completed_at as last_analyzed_at, aj.fresh_until
        from saved_analyses sa
        join wallets w on w.id = sa.wallet_id
        left join lateral (
          select aj2.id, aj2.status, aj2.completed_at, aj2.fresh_until
          from analysis_jobs aj2
          where aj2.wallet_id = sa.wallet_id and aj2.status = 'READY'
          order by aj2.created_at desc
          limit 1
        ) aj on true
        left join exposure_scores es on es.analysis_id = aj.id
        where sa.user_id = ${userId} and sa.wallet_id = ${walletId}
        limit 1
      `;
      return row ?? null;
    }
  };
}
