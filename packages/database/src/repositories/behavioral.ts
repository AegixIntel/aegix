import type { JsonValue, Sql } from "../client.js";

export interface BehavioralFeatureRow {
  id: string;
  wallet_id: string;
  feature_name: string;
  feature_value_number: number | null;
  feature_value_json: unknown;
  window: string;
  sample_size: number;
  computed_at: string;
  engine_version: string;
}

export interface BehavioralFeatureRepo {
  upsertFeatures(walletId: string, features: Array<{
    featureName: string;
    valueNumber: number | null;
    valueJson: unknown;
    sampleSize: number;
    engineVersion: string;
  }>): Promise<void>;
  featuresForWallet(walletId: string): Promise<BehavioralFeatureRow[]>;
}

/**
 * Behavioral feature repository, see docs/milestone-d5.md (D5-D).
 * Persists the behavior engine's distributions so the correlation engine can
 * compare wallets without re-running analysis.
 */
export function createBehavioralFeatureRepo(sql: Sql): BehavioralFeatureRepo {
  return {
    async upsertFeatures(walletId, features) {
      for (const f of features) {
        await sql`
          insert into behavioral_features (
            wallet_id, feature_name, feature_value_number, feature_value_json,
            "window", sample_size, computed_at, engine_version
          ) values (
            ${walletId}, ${f.featureName}, ${f.valueNumber},
            ${sql.json(f.valueJson as unknown as JsonValue)},
            'all', ${f.sampleSize}, now(), ${f.engineVersion}
          )
          on conflict (wallet_id, feature_name, "window", engine_version)
          do update set
            feature_value_number = excluded.feature_value_number,
            feature_value_json = excluded.feature_value_json,
            sample_size = excluded.sample_size,
            computed_at = now()
        `;
      }
    },
    async featuresForWallet(walletId) {
      return sql<BehavioralFeatureRow[]>`
        select * from behavioral_features
        where wallet_id = ${walletId}
        order by feature_name asc
      `;
    }
  };
}
