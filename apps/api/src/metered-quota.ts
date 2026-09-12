import type { Sql } from "@aegix/database";

/** Serializes admission and metering before paid provider work, including failures. */
export async function claimDailyUsage(sql: Sql, userId: string, usageType: "ask_aegix" | "markets" | "ask_markets", limit: number, analysisId: string | null = null) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${usageType}:${start.toISOString()}`}, 0))`;
    const [row] = await tx<Array<{ count: string }>>`select count(*)::text as count from usage_records
      where user_id = ${userId} and usage_type = ${usageType}
      and created_at >= ${start.toISOString()}::timestamptz and created_at < ${end.toISOString()}::timestamptz`;
    const used = Number(row?.count ?? 0);
    if (used < limit) await tx`insert into usage_records (user_id, usage_type, analysis_id)
      values (${userId}, ${usageType}, ${analysisId})`;
    return { allowed: used < limit, used: used < limit ? used + 1 : used, limit, resetAt: end.toISOString() };
  });
}
