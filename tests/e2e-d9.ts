import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@aegix/database";
import { claimDailyUsage } from "../apps/api/src/metered-quota.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

async function main() {
const safe = requireSafeTestDatabaseReset();
const sql = createDb(safe.databaseUrl);
const userId = randomUUID();
try {
  await sql`insert into profiles (id) values (${userId})`;
  const requests = await Promise.all(Array.from({ length: 12 }, () => claimDailyUsage(sql, userId, "ask_aegix", 3)));
  assert.equal(requests.filter((r) => r.allowed).length, 3, "concurrent provider admission cannot overspend quota");
  const [row] = await sql<Array<{ count: string }>>`select count(*)::text as count from usage_records where user_id = ${userId}`;
  assert.equal(Number(row?.count), 3, "every admitted provider request is metered once");
  console.log("D9 atomic quota/metering: PASS");
} finally {
  await sql`delete from usage_records where user_id = ${userId}`;
  await sql`delete from profiles where id = ${userId}`;
  await sql.end();
}
}
main().catch(() => { console.error("D9 atomic quota/metering: FAIL"); process.exitCode = 1; });
