/**
 * Public beta quota system, see milestone D3-F §34-§37.
 *
 * Config-driven daily limits per actor class:
 * - anonymous visitors: FREE_ANON_DAILY_LIMIT (by IP + anonymous key)
 * - registered users:   FREE_USER_DAILY_LIMIT (by user id)
 *
 * Only expensive analyses consume quota. Fresh cached results return
 * without consuming quota (tracked separately, D3-C §24).
 *
 * Usage is recorded in usage_records so it can be audited and reported.
 */

import type { Sql } from "@aegix/database";
import type { AppConfig } from "@aegix/config";

export interface QuotaContext {
  userId: string | null;
  anonymousKey: string | null;
  ip: string;
}

export interface QuotaResult {
  allowed: boolean;
  /** Remaining expensive analyses for the window, when allowed. */
  remaining: number;
  /** When the current window resets (ISO string). */
  resetAt: string;
  /** Which limit applies. */
  limit: number;
  used: number;
}

/** ISO date boundary for the current daily window (UTC). */
function windowStart(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ISO date boundary for the next daily window. */
function windowEnd(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export async function checkQuota(sql: Sql, config: AppConfig, ctx: QuotaContext, opts: { usageType?: string; limitOverride?: number } = {}): Promise<QuotaResult> {
  const now = new Date();
  const start = windowStart(now);
  const end = windowEnd(now);
  const usageType = opts.usageType ?? "expensive_analysis";
  const limit = opts.limitOverride ?? (ctx.userId ? config.FREE_USER_DAILY_LIMIT : config.FREE_ANON_DAILY_LIMIT);
  const key = ctx.userId ?? ctx.anonymousKey ?? `ip:${ctx.ip}`;

  const [row] = await sql<Array<{ count: string }>>`
    select count(*)::text as count
    from usage_records
    where usage_type = ${usageType}
      and created_at >= ${start}::timestamptz
      and created_at < ${end}::timestamptz
      and (user_id = ${ctx.userId} or anonymous_key = ${key})
  `;
  const used = row ? Number(row.count) : 0;
  return {
    allowed: used < limit,
    remaining: Math.max(0, limit - used),
    resetAt: end,
    limit,
    used
  };
}

/** Records an expensive analysis against the actor's daily quota. */
export async function recordQuotaUsage(
  sql: Sql,
  ctx: QuotaContext,
  analysisId: string | null,
  usageType: "expensive_analysis" | "comparison" | "wallet_context" = "expensive_analysis"
): Promise<void> {
  const key = ctx.userId ?? ctx.anonymousKey ?? `ip:${ctx.ip}`;
  await sql`
    insert into usage_records (user_id, anonymous_key, analysis_id, usage_type, wallet_id)
    values (${ctx.userId}, ${ctx.userId ? null : key}, ${analysisId}, ${usageType}, null)
  `;
}

/** Records a cache hit (no quota consumed) for analytics, see D3-C §24. */
export async function recordCacheHit(sql: Sql, ctx: QuotaContext, analysisId: string): Promise<void> {
  const key = ctx.userId ?? ctx.anonymousKey ?? `ip:${ctx.ip}`;
  await sql`
    insert into usage_records (user_id, anonymous_key, analysis_id, usage_type, wallet_id)
    values (${ctx.userId}, ${ctx.userId ? null : key}, ${analysisId}, 'cache_hit', null)
  `;
}
