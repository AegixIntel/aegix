import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "./server.js";
import { loadConfig } from "@aegix/config";

test("health endpoints respond", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379"
  });
  const app = await buildServer({ config });
  const res = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
  await app.close();
});

test("rejects invalid wallet addresses", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379"
  });
  const app = await buildServer({ config });
  const res = await app.inject({
    method: "POST",
    url: "/v1/analyses",
    payload: { address: "not-a-valid-solana-address" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "INVALID_WALLET");
  await app.close();
});
