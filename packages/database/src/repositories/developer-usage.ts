import type { Sql } from "../client.js";

export interface DeveloperUsageEventRow {
  id: string;
  user_id: string;
  api_key_id: string | null;
  operation: string;
  request_id: string;
  status: "SUCCESS" | "REJECTED";
  units: number;
  cache_hit: boolean;
  created_work: boolean;
  latency_ms: number | null;
  scope: string | null;
  created_at: string;
}

export interface DeveloperUsageSummary {
  periodStart: string;
  periodEnd: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  breakdown: Array<{ operation: string; units: number }>;
}

export interface DeveloperUsageRepo {
  /** Idempotent event insert keyed on request_id (D6-D §75, audit trail).
   *  userId may be null for unauthenticated rejections: the audit trail
   *  keeps the rejection without a user attribution. */
  record(input: {
    userId: string | null;
    apiKeyId: string | null;
    operation: string;
    requestId: string;
    status: "SUCCESS" | "REJECTED";
    units?: number;
    cacheHit?: boolean;
    createdWork?: boolean;
    latencyMs?: number | null;
    scope?: string | null;
  }): Promise<void>;
  /** Per-user usage in the current UTC day window (D6-D §68, §69). */
  summaryForUser(userId: string, limit: number, now?: Date): Promise<DeveloperUsageSummary>;
  /**
   * Atomic per-user quota claim (D6-D §70). Serializes on the counter row
   * lock: concurrent claims can never push the day's units past the limit.
   * Claimed units are NOT audit events — they only move the counter.
   */
  tryClaim(userId: string, units: number, limit: number, now?: Date): Promise<boolean>;
}

function windowBounds(now: Date): { start: string; end: string } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Developer usage metering repository, see docs/d6-block1.md (D6-D). */
export function createDeveloperUsageRepo(sql: Sql): DeveloperUsageRepo {
  return {
    async record(input) {
      await sql`
        insert into developer_usage_events (
          user_id, api_key_id, operation, request_id, status, units,
          cache_hit, created_work, latency_ms, scope
        ) values (
          ${input.userId}, ${input.apiKeyId}, ${input.operation}, ${input.requestId},
          ${input.status}, ${input.units ?? 1}, ${input.cacheHit ?? false},
          ${input.createdWork ?? false}, ${input.latencyMs ?? null}, ${input.scope ?? null}
        )
        on conflict (request_id) do nothing
      `;
    },

    async summaryForUser(userId, limit, now = new Date()) {
      const { start, end } = windowBounds(now);
      const [counter] = await sql<Array<{ units: string }>>`
        select units::text from developer_quota_counters
        where user_id = ${userId} and period_start = ${start}::timestamptz
        limit 1
      `;
      const rows = await sql<Array<{ operation: string; units: string }>>`
        select operation, coalesce(sum(units), 0)::text as units
        from developer_usage_events
        where user_id = ${userId}
          and created_at >= ${start}::timestamptz
          and created_at < ${end}::timestamptz
          and status = 'SUCCESS'
        group by operation
        order by units desc
      `;
      const used = counter ? Number(counter.units) : 0;
      return {
        periodStart: start,
        periodEnd: end,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        resetAt: end,
        breakdown: rows.map((r) => ({ operation: r.operation, units: Number(r.units) }))
      };
    },

    async tryClaim(userId, units, limit, now = new Date()) {
      const { start } = windowBounds(now);
      const [row] = await sql<Array<{ units: string }>>`
        insert into developer_quota_counters (user_id, period_start, units)
        select ${userId}, ${start}::timestamptz, ${units}
        where ${units} <= ${limit}
        on conflict (user_id, period_start) do update
          set units = developer_quota_counters.units + excluded.units,
              updated_at = now()
          where developer_quota_counters.units + excluded.units <= ${limit}
        returning units::text
      `;
      return row !== undefined;
    }
  };
}
