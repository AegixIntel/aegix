import type { JsonValue, Sql } from "../client.js";

export interface SignalRow {
  id: string;
  analysis_id: string;
  wallet_id: string;
  signal_type: string;
  category: string;
  severity: number;
  confidence: number;
  title: string;
  summary: string | null;
  evidence_json: unknown;
  source_engine: string | null;
  engine_version: string | null;
  created_at: string;
}

export interface ScoreRow {
  id: string;
  analysis_id: string;
  wallet_id: string;
  overall_score: number;
  identity_linkability: number;
  funding_exposure: number;
  wallet_cluster_exposure: number;
  behavioral_fingerprint: number;
  counterparty_exposure: number;
  entity_exposure: number;
  transaction_pattern_exposure: number;
  overall_confidence: number;
  scoring_version: string | null;
  created_at: string;
}

export interface PathRow {
  id: string;
  analysis_id: string;
  target_wallet_id: string;
  rank: number;
  path_type: string;
  nodes_json: unknown;
  edges_json: unknown;
  path_score: number;
  confidence_score: number;
  summary: string | null;
  engine_version: string | null;
  created_at: string;
}

export interface IntelligenceRepo {
  insertSignals(rows: Array<{
    analysisId: string;
    walletId: string;
    signalType: string;
    category: string;
    severity: number;
    confidence: number;
    title: string;
    summary: string;
    evidence: unknown;
    engineVersion: string;
  }>): Promise<void>;
  insertScore(row: {
    analysisId: string;
    walletId: string;
    overallScore: number;
    dimensions: Record<string, number>;
    overallConfidence: number;
    scoringVersion: string;
  }): Promise<void>;
  insertPaths(rows: Array<{
    analysisId: string;
    targetWalletId: string;
    rank: number;
    pathType: string;
    nodes: unknown;
    edges: unknown;
    pathScore: number;
    confidenceScore: number;
    summary: string;
    engineVersion: string;
  }>): Promise<void>;
  signalsForAnalysis(analysisId: string): Promise<SignalRow[]>;
  scoreForAnalysis(analysisId: string): Promise<ScoreRow | null>;
  pathsForAnalysis(analysisId: string): Promise<PathRow[]>;
  signalsForWallet(walletId: string, limit?: number): Promise<SignalRow[]>;
  scoreForWalletLatest(walletId: string): Promise<ScoreRow | null>;
}

/** Persists intelligence outputs (signals, scores, attack paths), see architecture.md §23-§34. */
export function createIntelligenceRepo(sql: Sql): IntelligenceRepo {
  return {
    async insertSignals(rows) {
      if (rows.length === 0) return;
      for (const s of rows) {
        await sql`
          insert into exposure_signals (
            analysis_id, wallet_id, signal_type, category, severity, confidence,
            title, summary, evidence_json, source_engine, engine_version
          ) values (
            ${s.analysisId}, ${s.walletId}, ${s.signalType}, ${s.category}, ${s.severity},
            ${s.confidence}, ${s.title}, ${s.summary}, ${sql.json(s.evidence as JsonValue)},
            ${s.engineVersion}, ${s.engineVersion}
          )
        `;
      }
    },

    async insertScore(row) {
      await sql`
        insert into exposure_scores (
          analysis_id, wallet_id, overall_score,
          identity_linkability, funding_exposure, wallet_cluster_exposure,
          behavioral_fingerprint, counterparty_exposure, entity_exposure,
          transaction_pattern_exposure, overall_confidence, scoring_version
        ) values (
          ${row.analysisId}, ${row.walletId}, ${row.overallScore},
          ${row.dimensions.identityLinkability ?? 0}, ${row.dimensions.fundingExposure ?? 0},
          ${row.dimensions.walletClusterExposure ?? 0}, ${row.dimensions.behavioralFingerprint ?? 0},
          ${row.dimensions.counterpartyExposure ?? 0}, ${row.dimensions.entityExposure ?? 0},
          ${row.dimensions.transactionPatternExposure ?? 0}, ${row.overallConfidence}, ${row.scoringVersion}
        )
      `;
    },

    async insertPaths(rows) {
      if (rows.length === 0) return;
      for (const p of rows) {
        await sql`
          insert into exposure_paths (
            analysis_id, target_wallet_id, rank, path_type, nodes_json, edges_json,
            path_score, confidence_score, summary, engine_version
          ) values (
            ${p.analysisId}, ${p.targetWalletId}, ${p.rank}, ${p.pathType},
            ${sql.json(p.nodes as JsonValue)}, ${sql.json(p.edges as JsonValue)}, ${p.pathScore},
            ${p.confidenceScore}, ${p.summary}, ${p.engineVersion}
          )
        `;
      }
    },

    async signalsForAnalysis(analysisId) {
      return sql<SignalRow[]>`
        select * from exposure_signals where analysis_id = ${analysisId} order by severity desc
      `;
    },

    async scoreForAnalysis(analysisId) {
      const [row] = await sql<ScoreRow[]>`
        select * from exposure_scores where analysis_id = ${analysisId} order by created_at desc limit 1
      `;
      return row ?? null;
    },

    async pathsForAnalysis(analysisId) {
      return sql<PathRow[]>`
        select * from exposure_paths where analysis_id = ${analysisId} order by rank asc
      `;
    },

    async signalsForWallet(walletId, limit = 20) {
      return sql<SignalRow[]>`
        select s.* from exposure_signals s
        join analysis_jobs j on j.id = s.analysis_id
        where s.wallet_id = ${walletId} and j.status = 'READY'
        order by s.severity desc
        limit ${limit}
      `;
    },

    async scoreForWalletLatest(walletId) {
      const [row] = await sql<ScoreRow[]>`
        select * from exposure_scores
        where wallet_id = ${walletId}
        order by created_at desc
        limit 1
      `;
      return row ?? null;
    }
  };
}
