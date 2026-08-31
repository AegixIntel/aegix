import type { JsonValue, Sql } from "../client.js";

export interface WalletRelationshipRow {
  id: string;
  wallet_a: string;
  wallet_b: string;
  relationship_type: string;
  direction: string;
  transaction_count: number;
  interaction_count: number;
  total_value: number;
  first_seen: string;
  last_seen: string;
  strength_score: number;
  confidence_score: number;
  evidence_json: unknown;
  engine_version: string;
  created_at: string;
  updated_at: string;
}

export interface RelationshipRepo {
  /** Idempotent upsert keyed on canonical (wallet_a, wallet_b, relationship_type). */
  upsert(input: {
    walletA: string;
    walletB: string;
    relationshipType: string;
    direction: string;
    transactionCount: number;
    interactionCount: number;
    totalValue: number;
    firstSeen: string;
    lastSeen: string;
    strengthScore: number;
    confidenceScore: number;
    evidence: unknown;
    engineVersion: string;
  }): Promise<WalletRelationshipRow>;
  listForWallet(walletAddress: string, limit?: number): Promise<WalletRelationshipRow[]>;
  listBetween(a: string, b: string): Promise<WalletRelationshipRow[]>;
}

/**
 * Wallet relationship repository, see docs/milestone-d5.md (D5-G §46-§47).
 * The table has existed since migration 0001 but was never written; D5 fills
 * it from the correlation engine and the analysis pipeline.
 */
export function createRelationshipRepo(sql: Sql): RelationshipRepo {
  const canonical = (a: string, b: string): [string, string] => ([a, b].sort() as [string, string]);

  return {
    async upsert(input) {
      const [walletA, walletB] = canonical(input.walletA, input.walletB);
      const [row] = await sql<WalletRelationshipRow[]>`
        insert into wallet_relationships (
          wallet_a, wallet_b, relationship_type, direction,
          transaction_count, interaction_count, total_value,
          first_seen, last_seen, strength_score, confidence_score,
          evidence_json, engine_version
        ) values (
          ${walletA}, ${walletB}, ${input.relationshipType}, ${input.direction},
          ${input.transactionCount}, ${input.interactionCount}, ${input.totalValue},
          ${input.firstSeen}, ${input.lastSeen}, ${input.strengthScore}, ${input.confidenceScore},
          ${sql.json(input.evidence as unknown as JsonValue)}, ${input.engineVersion}
        )
        on conflict (wallet_a, wallet_b, relationship_type) do update set
          direction = excluded.direction,
          transaction_count = excluded.transaction_count,
          interaction_count = excluded.interaction_count,
          total_value = excluded.total_value,
          first_seen = excluded.first_seen,
          last_seen = excluded.last_seen,
          strength_score = excluded.strength_score,
          confidence_score = excluded.confidence_score,
          evidence_json = excluded.evidence_json,
          engine_version = excluded.engine_version,
          updated_at = now()
        returning *
      `;
      if (!row) throw new Error("relationship upsert returned no row");
      return row;
    },
    async listForWallet(walletAddress, limit = 50) {
      return sql<WalletRelationshipRow[]>`
        select * from wallet_relationships
        where wallet_a = ${walletAddress} or wallet_b = ${walletAddress}
        order by strength_score desc
        limit ${limit}
      `;
    },
    async listBetween(a, b) {
      const [walletA, walletB] = canonical(a, b);
      return sql<WalletRelationshipRow[]>`
        select * from wallet_relationships
        where wallet_a = ${walletA} and wallet_b = ${walletB}
        order by strength_score desc
      `;
    }
  };
}
