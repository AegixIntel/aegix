import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "./server.js";
import { loadConfig } from "@aegix/config";

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379"
  });
}

test("health endpoints respond", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
  await app.close();
});

test("rejects invalid wallet addresses", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({
    method: "POST",
    url: "/v1/analyses",
    // 44 chars, valid base58 alphabet but not a valid Solana address
    payload: { address: "11111111111111111111111111111111111111111111" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "INVALID_WALLET");
  await app.close();
});

test("sends security headers on every response", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({ method: "GET", url: "/health/live" });

  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");

  const csp = res.headers["content-security-policy"];
  assert.ok(typeof csp === "string", "CSP header present");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/);

  await app.close();
});

// ---- D5-I: comparison endpoint validation (no DB dependency) ----

test("compare: rejects invalid wallet addresses", async () => {
  const app = await buildServer({ config: testConfig() });
  // 44 chars but not valid base58 (contains '0', 'O', 'I', 'l').
  const invalid = "0OIl0000000000000000000000000000000000000000";
  const res = await app.inject({
    method: "POST",
    url: "/v1/compare",
    payload: { walletA: invalid, walletB: "11111111111111111111111111111111111111111111" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "INVALID_WALLET");
  await app.close();
});

test("compare: rejects comparing a wallet with itself", async () => {
  const app = await buildServer({ config: testConfig() });
  const address = "7Z8ftDAzMvoyXnGEJye8DurzgQQXLAbYCaeeesM7UKHa";
  const res = await app.inject({
    method: "POST",
    url: "/v1/compare",
    payload: { walletA: address, walletB: address }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "DUPLICATE_WALLET");
  await app.close();
});

test("compare: rejects when D5 intelligence is disabled (kill switch)", async () => {
  const app = await buildServer({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
      REDIS_URL: "redis://localhost:6379",
      ENABLE_CORRELATION_ANALYSIS: "false",
      ENABLE_MULTI_HOP_GRAPH: "false"
    })
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/compare",
    payload: { walletA: "7Z8ftDAzMvoyXnGEJye8DurzgQQXLAbYCaeeesM7UKHa", walletB: "7d3y2WdzxE7CfsWjkGy3WndkvZcj1EHMkzKJiFPiDecH" }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "FEATURE_DISABLED");
  await app.close();
});
