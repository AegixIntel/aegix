import { randomUUID } from "node:crypto";
import { buildServer } from "../src/server.js";
import { loadConfig } from "@aegix/config";
import { createDb, createDeveloperApiKeyRepo } from "@aegix/database";
import { generateApiKey, hashApiKey, verifyApiKey } from "../src/developer-keys.js";
import { createDeveloperAuth } from "../src/developer-api.js";
import { createLogger } from "@aegix/logging";

const config = loadConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
  REDIS_URL: "redis://localhost:6379"
});
const sql = createDb(config.DATABASE_URL);
const repo = createDeveloperApiKeyRepo(sql);
const userId = randomUUID();
await sql`insert into profiles (id, display_name) values (${userId}, 'debug4')`;

const g = generateApiKey();
const key = g.key;
const keyPrefix = g.keyPrefix;
const row = await repo.create({
  userId,
  name: "debug4",
  keyPrefix,
  keyHash: hashApiKey(key),
  scopes: ["intelligence:read"],
  expiresAt: null
});
console.log("row created:", row.id, row.key_prefix, "key len:", key.length);
const found = await repo.findByPrefix(keyPrefix);
console.log("found by prefix:", found ? `id=${found.id} hash=${found.key_hash.slice(0, 12)}` : null, "| my hash:", hashApiKey(key).slice(0, 12));
console.log("verify:", found ? verifyApiKey(key, found.key_hash) : "n/a");

// Direct auth call, outside Fastify, with the same connection the server uses.
const auth = createDeveloperAuth({ sql, config, logger: createLogger(config, { service: "debug" }) });
const fakeReq = { headers: { authorization: `Bearer ${key}`, "x-request-id": "debug-req" } } as never;
const direct = await auth.authenticate(fakeReq);
console.log("direct authenticate:", JSON.stringify(direct).slice(0, 200));

const app = await buildServer({ config });
const res = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${key}` } });
console.log("status:", res.statusCode, JSON.stringify(res.json()).slice(0, 160));
await app.close();
await sql`delete from developer_api_keys where user_id = ${userId}`;
await sql`delete from developer_usage_events where user_id = ${userId}`;
await sql`delete from developer_quota_counters where user_id = ${userId}`;
await sql`delete from profiles where id = ${userId}`;
await sql.end();
process.exit(0);
