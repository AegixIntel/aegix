import type { JsonValue, Sql } from "../client.js";
import type { CorrelationResult } from "@aegix/types";

export interface CorrelationResultRow {
  id: string;
  wallet_a: string;
  wallet_b: string;
  correlation_score: number;
  confidence: string;
  classification: string;
  evidence_families: unknown;
  limitations: unknown;
  engine_version: string;
  created_at: string;
  updated_at: string;
}

export interface CorrelationRepo {
  /** Idempotent upsert on canonical (wallet_a, wallet_b). */
  upsert(result: CorrelationResult): Promise<CorrelationResultRow>;
  findByPair(a: string, b: string): Promise<CorrelationResultRow | null>;
  listForWallet(walletAddress: string, limit?: number): Promise<CorrelationResultRow[]>;
}

/** Correlation result repository, see docs/milestone-d5.md (D5-B §14). */
export function createCorrelationRepo(sql: Sql): CorrelationRepo {
  const canonical = (a: string, b: string): [string, string] => ([a, b].sort() as [string, string]);

  return {
    async upsert(result) {
      const [walletA, walletB] = canonical(result.pairId.split("|")[0]!, result.pairId.split("|")[1] ?? "");
      const [row] = await sql<CorrelationResultRow[]>`
        insert into correlation_results (
          wallet_a, wallet_b, correlation_score, confidence, classification,
          evidence_families, limitations, engine_version
        ) values (
          ${walletA}, ${walletB}, ${result.correlationScore}, ${result.confidence},
          ${result.classification}, ${sql.json(result.evidenceFamilies as unknown as JsonValue)},
          ${sql.json(result.limitations as unknown as JsonValue)}, ${result.engineVersion}
        )
        on conflict (wallet_a, wallet_b) do update set
          correlation_score = excluded.correlation_score,
          confidence = excluded.confidence,
          classification = excluded.classification,
          evidence_families = excluded.evidence_families,
          limitations = excluded.limitations,
          engine_version = excluded.engine_version,
          updated_at = now()
        returning *
      `;
      if (!row) throw new Error("correlation result upsert returned no row");
      return row;
    },
    async findByPair(a, b) {
      const [walletA, walletB] = canonical(a, b);
      const [row] = await sql<CorrelationResultRow[]>`
        select * from correlation_results
        where wallet_a = ${walletA} and wallet_b = ${walletB}
        limit 1
      `;
      return row ?? null;
    },
    async listForWallet(walletAddress, limit = 20) {
      return sql<CorrelationResultRow[]>`
        select * from correlation_results
        where wallet_a = ${walletAddress} or wallet_b = ${walletAddress}
        order by correlation_score desc
        limit ${limit}
      `;
    }
  };
}
