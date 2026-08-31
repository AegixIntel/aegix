import type { JsonValue, Sql } from "../client.js";

export interface RelationshipClusterRow {
  id: string;
  analysis_id: string;
  wallet_id: string;
  cluster_id: string;
  target_wallet: string;
  members: unknown;
  confidence: string;
  evidence_families: unknown;
  limitations: unknown;
  engine_version: string;
  created_at: string;
}

export interface RelationshipClusterRepo {
  /** Idempotent upsert keyed on (analysis_id, cluster_id) — D5-H §64, §87. */
  upsert(input: {
    analysisId: string;
    walletId: string;
    clusterId: string;
    targetWallet: string;
    members: unknown;
    confidence: number;
    evidenceFamilies: string[];
    limitations: string[];
    engineVersion: string;
  }): Promise<RelationshipClusterRow>;
  /** Replace all clusters for an analysis (re-run idempotency). */
  replaceForAnalysis(analysisId: string, walletId: string, rows: Array<Parameters<RelationshipClusterRepo["upsert"]>[0]>): Promise<void>;
  listForAnalysis(analysisId: string): Promise<RelationshipClusterRow[]>;
  listForWallet(walletAddress: string, limit?: number): Promise<RelationshipClusterRow[]>;
}

/** Relationship cluster repository, see docs/d5-block2.md (D5-H §64). */
export function createRelationshipClusterRepo(sql: Sql): RelationshipClusterRepo {
  return {
    async upsert(input) {
      const [row] = await sql<RelationshipClusterRow[]>`
        insert into relationship_clusters (
          analysis_id, wallet_id, cluster_id, target_wallet, members,
          confidence, evidence_families, limitations, engine_version
        ) values (
          ${input.analysisId}, ${input.walletId}, ${input.clusterId}, ${input.targetWallet},
          ${sql.json(input.members as unknown as JsonValue)}, ${input.confidence},
          ${sql.json(input.evidenceFamilies as unknown as JsonValue)},
          ${sql.json(input.limitations as unknown as JsonValue)}, ${input.engineVersion}
        )
        on conflict (analysis_id, cluster_id) do update set
          members = excluded.members,
          confidence = excluded.confidence,
          evidence_families = excluded.evidence_families,
          limitations = excluded.limitations,
          engine_version = excluded.engine_version
        returning *
      `;
      if (!row) throw new Error("relationship cluster upsert returned no row");
      return row;
    },

    async replaceForAnalysis(analysisId, walletId, rows) {
      await sql`delete from relationship_clusters where analysis_id = ${analysisId}`;
      for (const row of rows) {
        await this.upsert({ ...row, analysisId, walletId });
      }
    },

    async listForAnalysis(analysisId) {
      return sql<RelationshipClusterRow[]>`
        select * from relationship_clusters where analysis_id = ${analysisId} order by confidence desc
      `;
    },

    async listForWallet(walletAddress, limit = 10) {
      return sql<RelationshipClusterRow[]>`
        select rc.* from relationship_clusters rc
        join wallets w on w.id = rc.wallet_id
        where w.address = ${walletAddress}
        order by rc.created_at desc
        limit ${limit}
      `;
    }
  };
}
