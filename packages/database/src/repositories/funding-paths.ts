import type { JsonValue, Sql } from "../client.js";

export interface FundingPathRow {
  id: string;
  target_wallet_id: string;
  path: unknown;
  path_score: string;
  path_confidence: string;
  terminus_type: string;
  terminus_address: string;
  terminus_entity_name: string | null;
  engine_version: string;
  created_at: string;
}

export interface FundingPathRepo {
  /** Replace-all per target wallet (bounded set, see D5-C budgets). */
  replaceForTarget(targetWalletId: string, paths: Array<{
    path: unknown;
    pathScore: number;
    pathConfidence: number;
    terminusType: string;
    terminusAddress: string;
    terminusEntityName: string | null;
    engineVersion: string;
  }>): Promise<void>;
  listForTarget(targetWalletId: string): Promise<FundingPathRow[]>;
}

/** Funding provenance repository, see docs/milestone-d5.md (D5-C §20-§22). */
export function createFundingPathRepo(sql: Sql): FundingPathRepo {
  return {
    async replaceForTarget(targetWalletId, paths) {
      await sql`delete from funding_paths where target_wallet_id = ${targetWalletId}`;
      for (const p of paths) {
        await sql`
          insert into funding_paths (
            target_wallet_id, path, path_score, path_confidence,
            terminus_type, terminus_address, terminus_entity_name, engine_version
          ) values (
            ${targetWalletId}, ${sql.json(p.path as unknown as JsonValue)},
            ${p.pathScore}, ${p.pathConfidence}, ${p.terminusType},
            ${p.terminusAddress}, ${p.terminusEntityName}, ${p.engineVersion}
          )
        `;
      }
    },
    async listForTarget(targetWalletId) {
      return sql<FundingPathRow[]>`
        select * from funding_paths
        where target_wallet_id = ${targetWalletId}
        order by path_score desc
      `;
    }
  };
}
