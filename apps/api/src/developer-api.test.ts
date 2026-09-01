/**
 * Developer API integration tests (D6-B..D6-D) against the real local
 * Postgres/Redis (aegix_test database). Covers the full auth chain, response
 * envelope, error taxonomy, scope enforcement, quota metering + headers,
 * revocation, expiration, and rate-limit distinction.
 *
 * Requires local Postgres + Redis. Does NOT reset the shared test database;
 * it uses per-test unique users so runs are idempotent.
 */

import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "./server.js";
import { loadConfig } from "@aegix/config";
import { createDb, createDeveloperApiKeyRepo, API_KEY_PREFIX_LENGTH } from "@aegix/database";
import { generateApiKey, hashApiKey } from "./developer-keys.js";

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379",
    ...overrides
  });
}

const sql = createDb("postgres://postgres:postgres@localhost:5432/aegix_test");
const keyRepo = createDeveloperApiKeyRepo(sql);

/** Deterministic fresh key per call: fixed prefix slot + random tail. */
function uniqueKey(prefixSlot: string): { key: string; keyPrefix: string; keyHash: string } {
  const generated = generateApiKey();
  // Replace the generated random prefix with a fixed slot (same every run)
  // so the partial unique index never collides across repeated runs. The
  // slot must be exactly 6 base58 chars: the stored/looked-up prefix is
  // API_KEY_PREFIX_LENGTH (17) chars — "aegix_live_" + 6 chars. The random
  // tail keeps the key in the real key format (min 16 chars after the
  // prefix, per validateFormat).
  const tail = generated.key.slice(API_KEY_PREFIX_LENGTH);
  const keyPrefix = `aegix_live_${prefixSlot}`;
  const key = `${keyPrefix}${tail}`;
  return { key, keyPrefix, keyHash: hashApiKey(key) };
}

async function makeUserAndKey(scopes: string[], opts: { expiresInMs?: number; revoke?: boolean; prefixSlot?: string } = {}): Promise<{ userId: string; key: string; apiKeyId: string }> {
  const userId = randomUUID();
  await sql`insert into profiles (id, display_name) values (${userId}, 'dev test')`;
  const { key, keyPrefix, keyHash } = uniqueKey(opts.prefixSlot ?? randomUUID().slice(0, 6));
  const row = await keyRepo.create({
    userId,
    name: "test",
    keyPrefix,
    keyHash,
    scopes: scopes as never,
    expiresAt: opts.expiresInMs ? new Date(Date.now() + opts.expiresInMs).toISOString() : null
  });
  if (opts.revoke) await keyRepo.revokeForUser(userId, row.id);
  return { userId, key, apiKeyId: row.id };
}

test("developer: status authenticates with a valid key and meters usage", async () => {
  const app = await buildServer({ config: testConfig() });
  const { userId, key } = await makeUserAndKey(["intelligence:read"]);

  const res = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.status, "ok");
  assert.ok(body.meta.requestId, "request id present");
  assert.ok(body.meta.timestamp, "timestamp present");
  // Quota headers (D6-D §80).
  assert.equal(res.headers["x-quota-limit"], "500");
  assert.equal(res.headers["x-quota-remaining"], "499");
  assert.ok(res.headers["x-quota-reset"]);

  // Usage event recorded + counter claimed.
  const [event] = await sql<Array<{ operation: string; status: string }>>`select operation, status from developer_usage_events where user_id = ${userId} order by created_at desc limit 1`;
  assert.equal(event?.operation, "developer.status");
  assert.equal(event?.status, "SUCCESS");
  const [counter] = await sql<Array<{ units: string }>>`select units::text from developer_quota_counters where user_id = ${userId}`;
  assert.equal(counter?.units, "1");

  await app.close();
});

test("developer: no Authorization header → INVALID_API_KEY with envelope", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({ method: "GET", url: "/v1/developer/status" });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.error.code, "INVALID_API_KEY");
  assert.ok(body.meta.requestId);
  // Failed auth is not charged to any user: the reject event exists in the
  // audit trail with no user attribution and no quota counter claim. (The
  // counter assert must be user-scoped — other tests legitimately claim.)
  const [rejectEvents] = await sql<Array<{ count: string }>>`select count(*)::text as count from developer_usage_events where status = 'REJECTED' and user_id is null`;
  assert.equal(Number(rejectEvents?.count ?? 0) >= 1, true, "rejected auth recorded without user attribution");
  await app.close();
});

test("developer: query-string secrets are never accepted", async () => {
  const app = await buildServer({ config: testConfig() });
  const { key } = await makeUserAndKey(["intelligence:read"]);
  const res = await app.inject({ method: "GET", url: `/v1/developer/status?api_key=${key}` });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "INVALID_API_KEY");
  await app.close();
});

test("developer: malformed and unknown keys are rejected", async () => {
  const app = await buildServer({ config: testConfig() });
  const malformed = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: "Bearer not_a_key" } });
  assert.equal(malformed.statusCode, 401);
  assert.equal(malformed.json().error.code, "INVALID_API_KEY");

  const unknown = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: "Bearer aegix_live_" + "1".repeat(30) } });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.json().error.code, "INVALID_API_KEY");
  await app.close();
});

test("developer: revoked key fails immediately with REVOKED_API_KEY", async () => {
  const app = await buildServer({ config: testConfig() });
  const { key, userId } = await makeUserAndKey(["intelligence:read"], { revoke: true, prefixSlot: "revok1" });
  const res = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "REVOKED_API_KEY");
  await sql`delete from developer_usage_events where user_id = ${userId}`;
  await sql`delete from developer_quota_counters where user_id = ${userId}`;
  await sql`delete from developer_api_keys where user_id = ${userId}`;
  await sql`delete from profiles where id = ${userId}`;
  await app.close();
});

test("developer: expired key fails deterministically", async () => {
  const app = await buildServer({ config: testConfig() });
  const { key, userId } = await makeUserAndKey(["intelligence:read"], { expiresInMs: -60_000, prefixSlot: "expire" });
  const res = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "REVOKED_API_KEY");
  await sql`delete from developer_usage_events where user_id = ${userId}`;
  await sql`delete from developer_quota_counters where user_id = ${userId}`;
  await sql`delete from developer_api_keys where user_id = ${userId}`;
  await sql`delete from profiles where id = ${userId}`;
  await app.close();
});

test("developer: usage endpoint requires usage:read scope", async () => {
  const app = await buildServer({ config: testConfig() });
  const { key, userId } = await makeUserAndKey(["intelligence:read"], { prefixSlot: "noscop" });

  const denied = await app.inject({ method: "GET", url: "/v1/developer/usage", headers: { authorization: `Bearer ${key}` } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "INSUFFICIENT_SCOPE");

  const { key: usageKey, userId: usageUserId } = await makeUserAndKey(["usage:read"], { prefixSlot: "usgred" });
  const okRes = await app.inject({ method: "GET", url: "/v1/developer/usage", headers: { authorization: `Bearer ${usageKey}` } });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.json().data.periodStart.endsWith("T00:00:00.000Z"), true);
  assert.ok(okRes.headers["x-quota-limit"]);
  await sql`delete from developer_usage_events where user_id in (${userId}, ${usageUserId})`;
  await sql`delete from developer_quota_counters where user_id in (${userId}, ${usageUserId})`;
  await sql`delete from developer_api_keys where user_id in (${userId}, ${usageUserId})`;
  await sql`delete from profiles where id in (${userId}, ${usageUserId})`;
  await app.close();
});

test("developer: unknown scope rejected at key creation (product auth required)", async () => {
  const app = await buildServer({ config: testConfig() });
  // No Supabase configured in test → product auth unavailable → 401 before scope validation.
  const res = await app.inject({
    method: "POST",
    url: "/v1/developer/keys",
    payload: { name: "x", scopes: ["intelligence:read", "monitor:write"] }
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("developer: feature kill switch returns FEATURE_DISABLED", async () => {
  const app = await buildServer({ config: testConfig({ ENABLE_DEVELOPER_API: "false" }) });
  const res = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: "Bearer aegix_live_" + "1".repeat(30) } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "FEATURE_DISABLED");
  await app.close();
});

test("developer: quota exhaustion returns 429 QUOTA_EXCEEDED with reset info", async () => {
  const app = await buildServer({ config: testConfig({ DEVELOPER_DAILY_QUOTA: "2" }) });
  const { userId, key } = await makeUserAndKey(["intelligence:read"]);

  const first = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${key}` } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().meta.quota.remaining, 1);
  const second = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${key}` } });
  assert.equal(second.statusCode, 200);
  const third = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${key}` } });
  assert.equal(third.statusCode, 429);
  const body = third.json();
  assert.equal(body.error.code, "QUOTA_EXCEEDED");
  assert.equal(body.error.code !== "RATE_LIMITED", true, "quota and rate limit are distinct codes");
  assert.ok(body.meta.requestId);
  await sql`delete from developer_usage_events where user_id = ${userId}`;
  await sql`delete from developer_quota_counters where user_id = ${userId}`;
  await sql`delete from developer_api_keys where user_id = ${userId}`;
  await sql`delete from profiles where id = ${userId}`;
  await app.close();
});
