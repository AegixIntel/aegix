import type { JsonValue, Sql } from "../client.js";

export type PopulationObservationType = "COUNTERPARTY" | "ENTITY" | "PROGRAM" | "MINT";

export interface PopulationObservationStatRow {
  id: string;
  observation_type: PopulationObservationType;
  observation_key: string;
  distinct_wallets: number;
  observation_count: number;
  population_size: number;
  frequency: number;
  version: string;
  updated_at: string;
}

export interface PopulationContributionStateRow {
  wallet_id: string;
  analysis_id: string;
  version: string;
  contributed_at: string;
}

export interface PopulationCommonalityRepo {
  /**
   * Replaces one wallet's contribution for a version (snapshot semantics).
   * Idempotent per (wallet, version) via population_contribution_state:
   * re-analysis of the same wallet never double-counts (D6-G §93-§95).
   * Returns the population size (distinct analyzed wallets) for the version.
   */
  replaceContribution(input: {
    walletId: string;
    analysisId: string;
    version: string;
    /** observation_type -> key -> count observed by THIS wallet. */
    observations: Map<PopulationObservationType, Map<string, number>>;
  }): Promise<{ populationSize: number }>;
  /** Commonality stats for a set of keys (all types share the key space). */
  statsForKeys(keys: string[], version: string): Promise<PopulationObservationStatRow[]>;
  /** Current analyzed population size for a version (distinct wallets). */
  populationSize(version: string): Promise<number>;
  /** Latest contribution timestamp for a version (snapshot freshness). */
  lastAggregationAt(version: string): Promise<string | null>;
}

/** Population commonality repository, see docs/d6-block2.md (D6-G). */
export function createPopulationCommonalityRepo(sql: Sql): PopulationCommonalityRepo {
  return {
    async replaceContribution(input) {
      const { walletId, analysisId, version } = input;

      // Snapshot semantics inside one transaction: remove this wallet's
      // previous contribution for the version, then re-add the current one.
      // The state row is the idempotency anchor — the whole block is a no-op
      // when the same analysis was already aggregated (duplicate worker
      // execution / retries).
      return sql.begin(async (tx) => {
        const [state] = await tx<Array<{ analysis_id: string; observation_keys: unknown }>>`
          select analysis_id::text, observation_keys from population_contribution_state
          where wallet_id = ${walletId} and version = ${version}
          limit 1
        `;
        if (state && state.analysis_id === analysisId) {
          const [sz] = await tx<Array<{ count: string }>>`
            select count(*)::text as count from population_contribution_state where version = ${version}
          `;
          return { populationSize: sz ? Number(sz.count) : 0 };
        }

        // Remove the stale contribution (if any) for this wallet+version:
        // only the keys this wallet previously contributed are decremented
        // (snapshot semantics, §93-§95). Other wallets' contributions are
        // never touched.
        const staleKeys = (state?.observation_keys ?? []) as Array<{ observation_type: string; observation_key: string; count?: number }>;
        if (staleKeys.length > 0) {
          const keyRows: Array<{ observation_type: string; observation_key: string; count: number }> = [];
          for (const k of staleKeys) {
            if (typeof k.observation_type === "string" && typeof k.observation_key === "string") {
              // Older contribution rows predate stored counts; treating those
              // as one preserves backwards compatibility without allowing a
              // new analysis to accumulate its repeated observations forever.
              keyRows.push({ observation_type: k.observation_type, observation_key: k.observation_key, count: typeof k.count === "number" ? k.count : 1 });
            }
          }
          if (keyRows.length > 0) {
            await tx`
              update population_observation_stats s
              set distinct_wallets = greatest(0, s.distinct_wallets - 1),
                  observation_count = greatest(0, s.observation_count - r.count),
                  updated_at = now()
              from jsonb_to_recordset(${tx.json(keyRows as unknown as JsonValue)}::jsonb) as r(
                observation_type text, observation_key text, count integer
              )
              where s.observation_type = r.observation_type
                and s.observation_key = r.observation_key
                and s.version = ${version}
            `;
          }
        }

        // Re-add the current contribution.
        const rows: Array<{ observation_type: string; observation_key: string; count: number }> = [];
        for (const [type, keys] of input.observations) {
          for (const [key, count] of keys) {
            rows.push({ observation_type: type, observation_key: key, count });
          }
        }
        if (rows.length > 0) {
          await tx`
            insert into population_observation_stats (observation_type, observation_key, distinct_wallets, observation_count, population_size, frequency, version)
            select r.observation_type, r.observation_key, 1, r.count, 0, 0, ${version}
            from jsonb_to_recordset(${tx.json(rows as unknown as JsonValue)}::jsonb) as r(
              observation_type text, observation_key text, count integer
            )
            on conflict (observation_type, observation_key, version) do update set
              distinct_wallets = population_observation_stats.distinct_wallets + 1,
              observation_count = population_observation_stats.observation_count + excluded.observation_count,
              updated_at = now()
          `;
        }

        // Record the contribution state (idempotency anchor) + the keys this
        // wallet contributed, so a future re-analysis can decrement exactly
        // those stats (snapshot semantics).
        const keysForState = rows.map((r) => ({
          observation_type: r.observation_type,
          observation_key: r.observation_key,
          count: r.count
        }));
        await tx`
          insert into population_contribution_state (wallet_id, analysis_id, version, observation_keys)
          values (${walletId}, ${analysisId}, ${version}, ${tx.json(keysForState as unknown as JsonValue)})
          on conflict (wallet_id) do update set
            analysis_id = ${analysisId}, version = ${version}, observation_keys = ${tx.json(keysForState as unknown as JsonValue)},
            contributed_at = now()
        `;

        // Refresh population_size + frequency for every touched row.
        const [pop] = await tx<Array<{ count: string }>>`
          select count(*)::text as count from population_contribution_state where version = ${version}
        `;
        const populationSize = pop ? Number(pop.count) : 0;
        if (populationSize > 0) {
          await tx`
            update population_observation_stats
            set population_size = ${populationSize},
                frequency = case when ${populationSize} > 0 then distinct_wallets::numeric / ${populationSize} else 0 end
            where version = ${version}
          `;
        }
        return { populationSize };
      });
    },

    async statsForKeys(keys, version) {
      if (keys.length === 0) return [];
      return sql<PopulationObservationStatRow[]>`
        select id::text, observation_type, observation_key, distinct_wallets,
          observation_count, population_size, frequency::text::numeric::float8 as frequency, version, updated_at
        from population_observation_stats
        where version = ${version} and observation_key = any(${keys})
      `;
    },

    async populationSize(version) {
      const [row] = await sql<Array<{ count: string }>>`
        select count(*)::text as count from population_contribution_state where version = ${version}
      `;
      return row ? Number(row.count) : 0;
    },

    async lastAggregationAt(version) {
      const [row] = await sql<Array<{ at: string | null }>>`
        select max(contributed_at)::text as at from population_contribution_state where version = ${version}
      `;
      return row?.at ?? null;
    }
  };
}
