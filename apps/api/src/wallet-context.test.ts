import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "./server.js";
import { loadConfig } from "@aegix/config";

/** A real, valid Solana address (the wrapped SOL mint). */
const VALID_WALLET = "So11111111111111111111111111111111111111112";
/** 44 chars, valid base58 alphabet, not a valid Solana address. */
const INVALID_WALLET = "11111111111111111111111111111111111111111111";

function testConfig(over: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379",
    ...over
  });
}

test("wallet context: rejects invalid wallet addresses before touching auth", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({ method: "GET", url: `/v1/wallets/${INVALID_WALLET}/context` });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "INVALID_WALLET");
  await app.close();
});

test("wallet context: requires an authenticated session", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({ method: "GET", url: `/v1/wallets/${VALID_WALLET}/context` });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "UNAUTHENTICATED");
  await app.close();
});

test("wallet context: the kill switch retires the surface", async () => {
  const app = await buildServer({ config: testConfig({ ENABLE_WALLET_CONTEXT: "false" }) });
  const res = await app.inject({ method: "GET", url: `/v1/wallets/${VALID_WALLET}/context` });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "FEATURE_DISABLED");
  await app.close();
});

test("wallet context: the kill switch does not disable Wallet X-Ray", async () => {
  const app = await buildServer({ config: testConfig({ ENABLE_WALLET_CONTEXT: "false" }) });
  // X-Ray validates the address before it reaches the database, so this shows
  // the route still serving while D8 is retired, without needing one.
  const res = await app.inject({ method: "GET", url: `/v1/wallets/${INVALID_WALLET}/x-ray` });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "INVALID_WALLET");
  await app.close();
});
