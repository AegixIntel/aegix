import type { Sql } from "../client.js";

export interface MonitorCheckRow {
  id: string;
  monitor_id: string;
  scheduled_for: string;
  started_at: string | null;
  completed_at: string | null;
  status: string;
  delay_ms: number | null;
  analysis_id: string | null;
  reused_analysis: boolean;
  previous_analysis_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export interface MonitorCheckRepo {
  insert(input: { monitorId: string; scheduledFor: string }): Promise<MonitorCheckRow>;
  markStarted(id: string): Promise<void>;
  markCompleted(id: string, input: { status: string; analysisId: string | null; reused: boolean; previousAnalysisId: string | null }): Promise<void>;
  markDelayed(id: string, delayMs: number, reason: string): Promise<void>;
  markFailed(id: string, code: string, message: string): Promise<void>;
  listForMonitor(monitorId: string, limit: number): Promise<MonitorCheckRow[]>;
}

/** Monitor check audit trail, see docs/milestone-d4.md (D4-B §17, D4-I §77). */
export function createMonitorCheckRepo(sql: Sql): MonitorCheckRepo {
  return {
    async insert(input) {
      const [row] = await sql<MonitorCheckRow[]>`
        insert into monitor_checks (monitor_id, scheduled_for)
        values (${input.monitorId}, ${input.scheduledFor})
        returning *
      `;
      if (!row) throw new Error("monitor check insert returned no row");
      return row;
    },

    async markStarted(id) {
      await sql`
        update monitor_checks
        set status = 'IN_PROGRESS', started_at = now()
        where id = ${id}
      `;
    },

    async markCompleted(id, input) {
      await sql`
        update monitor_checks
        set status = ${input.status}, completed_at = now(),
            analysis_id = ${input.analysisId},
            reused_analysis = ${input.reused},
            previous_analysis_id = ${input.previousAnalysisId}
        where id = ${id}
      `;
    },

    async markDelayed(id, delayMs, reason) {
      await sql`
        update monitor_checks
        set status = 'DELAYED', delay_ms = ${delayMs}, error_message = ${reason}
        where id = ${id}
      `;
    },

    async markFailed(id, code, message) {
      await sql`
        update monitor_checks
        set status = 'FAILED', completed_at = now(),
            error_code = ${code}, error_message = ${message}
        where id = ${id}
      `;
    },

    async listForMonitor(monitorId, limit) {
      return sql<MonitorCheckRow[]>`
        select * from monitor_checks
        where monitor_id = ${monitorId}
        order by created_at desc
        limit ${limit}
      `;
    }
  };
}
