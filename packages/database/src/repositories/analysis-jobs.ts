import type { JsonValue, Sql } from "../client.js";

export type JobStatus =
  | "CREATED"
  | "QUEUED"
  | "FETCHING"
  | "NORMALIZING"
  | "ENTITY_ANALYSIS"
  | "RELATIONSHIP_ANALYSIS"
  | "BEHAVIOR_ANALYSIS"
  | "SCORING"
  | "GRAPH_ANALYSIS"
  | "EXPLANATION"
  | "PERSISTING"
  | "READY"
  | "FAILED"
  | "PARTIAL"
  | "CANCELLED";

export interface AnalysisJobRow {
  id: string;
  wallet_id: string;
  requested_by: string | null;
  analysis_type: string;
  status: JobStatus;
  priority: string;
  progress: number;
  engine_version: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  chain_data_until: string | null;
  fresh_until: string | null;
  data_quality: unknown;
}

export interface AnalysisJobRepo {
  create(input: {
    walletId: string;
    requestedBy: string | null;
    analysisType: string;
    priority: string;
  }): Promise<AnalysisJobRow>;
  findById(id: string): Promise<AnalysisJobRow | null>;
  updateStatus(id: string, status: JobStatus, progress?: number): Promise<void>;
  markStarted(id: string, engineVersion: string): Promise<void>;
  markCompleted(id: string, freshness: { chainDataUntil: string; freshUntil: string }, dataQuality: JsonValue): Promise<void>;
  markFailed(id: string, code: string, message: string): Promise<void>;
  latestForWallet(walletId: string): Promise<AnalysisJobRow | null>;
  /** Newest job of any status, so a client can find an analysis still running. */
  latestJobForWallet(walletId: string): Promise<AnalysisJobRow | null>;
  /** READY analyses for a wallet, newest first — exposure timeline (D4-G §58). */
  listReadyForWallet(walletId: string, limit: number): Promise<AnalysisJobRow[]>;
}

export function createAnalysisJobRepo(sql: Sql): AnalysisJobRepo {
  return {
    async create(input) {
      const [row] = await sql<AnalysisJobRow[]>`
        insert into analysis_jobs (wallet_id, requested_by, analysis_type, priority)
        values (${input.walletId}, ${input.requestedBy}, ${input.analysisType}, ${input.priority})
        returning *
      `;
      if (!row) throw new Error("analysis job insert returned no row");
      return row;
    },

    async findById(id) {
      const [row] = await sql<AnalysisJobRow[]>`
        select * from analysis_jobs where id = ${id}
      `;
      return row ?? null;
    },

    async updateStatus(id, status, progress) {
      await sql`
        update analysis_jobs
        set status = ${status},
            progress = coalesce(${progress ?? null}, progress),
            updated_at = now()
        where id = ${id}
      `;
    },

    async markStarted(id, engineVersion) {
      await sql`
        update analysis_jobs
        set status = 'FETCHING',
            started_at = now(),
            engine_version = ${engineVersion},
            failure_code = null,
            failure_message = null,
            failed_at = null,
            updated_at = now()
        where id = ${id}
      `;
    },

    async markCompleted(id, freshness, dataQuality) {
      await sql`
        update analysis_jobs
        set status = 'READY',
            progress = 100,
            completed_at = now(),
            chain_data_until = ${freshness.chainDataUntil},
            fresh_until = ${freshness.freshUntil},
            data_quality = ${sql.json(dataQuality)},
            failure_code = null,
            failure_message = null,
            failed_at = null,
            updated_at = now()
        where id = ${id}
      `;
    },

    async markFailed(id, code, message) {
      await sql`
        update analysis_jobs
        set status = 'FAILED',
            failed_at = now(),
            failure_code = ${code},
            failure_message = ${message},
            updated_at = now()
        where id = ${id}
      `;
    },

    async latestForWallet(walletId) {
      const [row] = await sql<AnalysisJobRow[]>`
        select * from analysis_jobs
        where wallet_id = ${walletId} and status = 'READY'
        order by created_at desc
        limit 1
      `;
      return row ?? null;
    },

    async latestJobForWallet(walletId) {
      const [row] = await sql<AnalysisJobRow[]>`
        select * from analysis_jobs
        where wallet_id = ${walletId}
        order by created_at desc
        limit 1
      `;
      return row ?? null;
    },

    async listReadyForWallet(walletId, limit) {
      return sql<AnalysisJobRow[]>`
        select * from analysis_jobs
        where wallet_id = ${walletId} and status = 'READY'
        order by created_at desc
        limit ${limit}
      `;
    }
  };
}
