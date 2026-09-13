import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "./server.js";
import { loadConfig } from "@aegix/config";

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379",
    ...overrides
  });
}

// ---- client IP behind a reverse proxy ----
// Rate limits, per-IP admission and the anonymous quota all key on req.ip.

function remaining(res: { headers: Record<string, unknown> }): string {
  return String(res.headers["x-ratelimit-remaining"]);
}

test("behind a trusted proxy hop, each client gets its own rate-limit bucket", async () => {
  const app = await buildServer({ config: testConfig({ TRUST_PROXY_HOPS: "1" }) });
  const a = await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "203.0.113.1" } });
  const b = await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "203.0.113.2" } });
  assert.equal(remaining(a), "119");
  assert.equal(remaining(b), "119");
  await app.close();
});

test("a client cannot spoof its IP by sending X-Forwarded-For through the proxy", async () => {
  const app = await buildServer({ config: testConfig({ TRUST_PROXY_HOPS: "1" }) });
  await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "203.0.113.1" } });
  // nginx appends the real client after whatever the client sent.
  const spoofed = await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.1" } });
  assert.equal(remaining(spoofed), "118");
  await app.close();
});

test("without trusted hops, X-Forwarded-For is ignored and the socket address keys limits", async () => {
  const app = await buildServer({ config: testConfig() });
  const a = await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "203.0.113.1" } });
  const b = await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "203.0.113.2" } });
  assert.equal(remaining(a), "119");
  assert.equal(remaining(b), "118");
  await app.close();
});

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

// ---- D6-J §62: request body limits ----

test("body limit: payloads above the configured ceiling are rejected with 413 (not silently truncated)", async () => {
  const app = await buildServer({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
      REDIS_URL: "redis://localhost:6379",
      API_BODY_LIMIT_BYTES: "1024"
    })
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/analyses",
    payload: { address: "EH2qq6FqPHk1vbfLjaNceGADeKTTPEVuQmQyC9YtYMmj", padding: "x".repeat(5000) }
  });
  assert.equal(res.statusCode, 413);
  await app.close();
});

test("body limit: legitimate large-ish bodies pass the raised ceiling (labels/notes supported)", async () => {
  const app = await buildServer({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
      REDIS_URL: "redis://localhost:6379"
    })
  });
  // Notes up to 2000 chars are allowed by schema; without auth this request
  // must reach the auth gate (401), NOT be rejected at the body limit.
  const res = await app.inject({
    method: "POST",
    url: "/v1/me/saved-comparisons",
    payload: { walletA: "EH2qq6FqPHk1vbfLjaNceGADeKTTPEVuQmQyC9YtYMmj", walletB: "DpFKMQXG21YQTUsCKGusU6SuQpAnR87dqu5DJL8Hm8Eb", notes: "n".repeat(2000) }
  });
  assert.equal(res.statusCode, 401, `expected auth gate, got ${res.statusCode}`);
  await app.close();
});
