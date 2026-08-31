import type { Sql } from "../client.js";

export interface MonitorRow {
  id: string;
  user_id: string;
  wallet_id: string;
  saved_analysis_id: string | null;
  status: string;
  schedule_type: string;
  last_checked_at: string | null;
  next_check_at: string | null;
  last_analysis_id: string | null;
  baseline_analysis_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonitorViewRow {
  id: string;
  user_id: string;
  wallet_id: string;
  wallet_address: string;
  saved_analysis_id: string | null;
  label: string | null;
  status: string;
  schedule_type: string;
  last_checked_at: string | null;
  next_check_at: string | null;
  last_analysis_id: string | null;
  baseline_analysis_id: string | null;
  score: number | null;
  confidence: number | null;
  last_analyzed_at: string | null;
  unread_notifications: string;
  created_at: string;
  updated_at: string;
}

export interface MonitorRepo {
  create(input: {
    userId: string;
    walletId: string;
    savedAnalysisId: string | null;
    scheduleType: string;
    baselineAnalysisId: string | null;
    nextCheckAt: string;
  }): Promise<MonitorRow>;
  listForUser(userId: string): Promise<MonitorViewRow[]>;
  getForUser(userId: string, monitorId: string): Promise<MonitorViewRow | null>;
  getRowForUser(userId: string, monitorId: string): Promise<MonitorRow | null>;
  /** Worker-side lookup without a user context (scheduler path). */
  getRowForUserOwned(monitorId: string): Promise<MonitorRow | null>;
  updateSchedule(userId: string, monitorId: string, scheduleType: string, nextCheckAt: string): Promise<boolean>;
  setStatus(userId: string, monitorId: string, status: string): Promise<boolean>;
  /** Worker-side status update (scheduler path). */
  setStatusById(monitorId: string, status: string): Promise<void>;
  listDue(now: string, limit: number): Promise<MonitorRow[]>;
  listActiveForWallet(walletId: string): Promise<MonitorRow[]>;
  setLastAnalysis(monitorId: string, analysisId: string): Promise<void>;
  touchCheck(monitorId: string, analysisId: string): Promise<void>;
  countActiveForUser(userId: string): Promise<number>;
}

/** Privacy monitor repository, see docs/milestone-d4.md (D4-A). */
export function createMonitorRepo(sql: Sql): MonitorRepo {
  return {
    async create(input) {
      const [row] = await sql<MonitorRow[]>`
        insert into privacy_monitors (
          user_id, wallet_id, saved_analysis_id, schedule_type,
          baseline_analysis_id, last_analysis_id, next_check_at
        )
        values (
          ${input.userId}, ${input.walletId}, ${input.savedAnalysisId}, ${input.scheduleType},
          ${input.baselineAnalysisId}, ${input.baselineAnalysisId}, ${input.nextCheckAt}
        )
        returning *
      `;
      if (!row) throw new Error("monitor insert returned no row");
      return row;
    },

    async listForUser(userId) {
      return sql<MonitorViewRow[]>`
        select
          pm.id::text, pm.user_id::text, pm.wallet_id::text,
          w.address as wallet_address, pm.saved_analysis_id::text,
          sa.label, pm.status, pm.schedule_type,
          pm.last_checked_at, pm.next_check_at,
          pm.last_analysis_id::text, pm.baseline_analysis_id::text,
          es.overall_score as score, es.overall_confidence as confidence,
          aj.completed_at as last_analyzed_at,
          coalesce((
            select count(*)::text from notifications n
            where n.user_id = ${userId} and n.monitor_id = pm.id and n.read_at is null
          ), '0') as unread_notifications,
          pm.created_at, pm.updated_at
        from privacy_monitors pm
        join wallets w on w.id = pm.wallet_id
        left join saved_analyses sa on sa.id = pm.saved_analysis_id
        left join lateral (
          select aj2.id, aj2.completed_at
          from analysis_jobs aj2
          where aj2.id = pm.last_analysis_id
          limit 1
        ) aj on true
        left join exposure_scores es on es.analysis_id = aj.id
        where pm.user_id = ${userId}
        order by pm.created_at desc
      `;
    },

    async getForUser(userId, monitorId) {
      const [row] = await sql<MonitorViewRow[]>`
        select
          pm.id::text, pm.user_id::text, pm.wallet_id::text,
          w.address as wallet_address, pm.saved_analysis_id::text,
          sa.label, pm.status, pm.schedule_type,
          pm.last_checked_at, pm.next_check_at,
          pm.last_analysis_id::text, pm.baseline_analysis_id::text,
          es.overall_score as score, es.overall_confidence as confidence,
          aj.completed_at as last_analyzed_at,
          coalesce((
            select count(*)::text from notifications n
            where n.user_id = ${userId} and n.monitor_id = pm.id and n.read_at is null
          ), '0') as unread_notifications,
          pm.created_at, pm.updated_at
        from privacy_monitors pm
        join wallets w on w.id = pm.wallet_id
        left join saved_analyses sa on sa.id = pm.saved_analysis_id
        left join lateral (
          select aj2.id, aj2.completed_at
          from analysis_jobs aj2
          where aj2.id = pm.last_analysis_id
          limit 1
        ) aj on true
        left join exposure_scores es on es.analysis_id = aj.id
        where pm.user_id = ${userId} and pm.id = ${monitorId}
        limit 1
      `;
      return row ?? null;
    },

    async getRowForUser(userId, monitorId) {
      const [row] = await sql<MonitorRow[]>`
        select * from privacy_monitors
        where user_id = ${userId} and id = ${monitorId}
        limit 1
      `;
      return row ?? null;
    },

    async getRowForUserOwned(monitorId) {
      const [row] = await sql<MonitorRow[]>`
        select * from privacy_monitors
        where id = ${monitorId}
        limit 1
      `;
      return row ?? null;
    },

    async updateSchedule(userId, monitorId, scheduleType, nextCheckAt) {
      const result = await sql`
        update privacy_monitors
        set schedule_type = ${scheduleType}, next_check_at = ${nextCheckAt}, updated_at = now()
        where user_id = ${userId} and id = ${monitorId}
      `;
      return result.count > 0;
    },

    async setStatus(userId, monitorId, status) {
      const result = await sql`
        update privacy_monitors
        set status = ${status}, updated_at = now()
        where user_id = ${userId} and id = ${monitorId}
      `;
      return result.count > 0;
    },

    async setStatusById(monitorId, status) {
      await sql`
        update privacy_monitors
        set status = ${status}, updated_at = now()
        where id = ${monitorId}
      `;
    },

    async listDue(now, limit) {
      return sql<MonitorRow[]>`
        select * from privacy_monitors
        where status = 'ACTIVE' and next_check_at <= ${now}
        order by next_check_at asc
        limit ${limit}
      `;
    },

    async listActiveForWallet(walletId) {
      return sql<MonitorRow[]>`
        select * from privacy_monitors
        where wallet_id = ${walletId} and status in ('ACTIVE', 'DEGRADED')
        order by id asc
      `;
    },

    async setLastAnalysis(monitorId, analysisId) {
      await sql`
        update privacy_monitors
        set last_analysis_id = ${analysisId}, updated_at = now()
        where id = ${monitorId}
      `;
    },

    async touchCheck(monitorId, analysisId) {
      await sql`
        update privacy_monitors
        set last_analysis_id = ${analysisId},
            last_checked_at = now(),
            next_check_at = now() + interval '1 day',
            status = 'ACTIVE',
            updated_at = now()
        where id = ${monitorId}
      `;
    },

    async countActiveForUser(userId) {
      const [row] = await sql<Array<{ count: string }>>`
        select count(*)::text as count from privacy_monitors
        where user_id = ${userId} and status in ('ACTIVE', 'DEGRADED')
      `;
      return row ? Number(row.count) : 0;
    }
  };
}
