import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlockchainProvider, SignatureInfo } from "./types.js";
import { ProviderCircuit, ProviderPool } from "./provider-pool.js";

function fakeProvider(name: string, behavior: { fail?: boolean; failCount?: number; latencyMs?: number } = {}): BlockchainProvider {
  let calls = 0;
  return {
    chain: "solana",
    name,
    validateAddress: () => true,
    async getSignatures() {
      calls += 1;
      if (behavior.fail && (behavior.failCount === undefined || calls <= behavior.failCount)) {
        throw new Error("429 Too Many Requests");
      }
      await new Promise((r) => setTimeout(r, behavior.latencyMs ?? 0));
      return [{ signature: `sig-${name}-${calls}`, slot: 1, blockTime: 1 }] as SignatureInfo[];
    },
    async getTransaction() {
      throw new Error("not implemented");
    },
    async getTokenAccounts() {
      return [];
    },
    async getBalance() {
      return 0;
    },
    async getLatestBlockHeight() {
      return 1;
    }
  };
}

test("pool fails over from failing primary to healthy secondary", async () => {
  const pool = new ProviderPool({
    providers: [fakeProvider("primary", { fail: true }), fakeProvider("secondary")],
    failureThreshold: 2,
    cooldownMs: 100
  });

  const sigs = await pool.getSignatures("wallet");
  assert.equal(sigs[0]!.signature.startsWith("sig-secondary"), true);
  const stats = pool.getStats();
  assert.equal(stats.lastProvider, "secondary");
  // primary recorded a failure and is deprioritized while secondary stays healthy
  assert.equal(stats.circuits["primary"]!.requestCount, 1);
  assert.equal(stats.circuits["primary"]!.lastError, "429 Too Many Requests");
  assert.equal(stats.circuits["secondary"]!.requestCount, 1);
});

test("circuit opens after threshold then recovers via half-open probe", async () => {
  const primary = fakeProvider("primary", { fail: true, failCount: 4 });
  // No secondary: failures must surface as rejections so the circuit can be observed.
  const pool = new ProviderPool({
    providers: [primary],
    failureThreshold: 3,
    cooldownMs: 50
  });

  // 3 failures -> circuit OPEN
  await assert.rejects(() => pool.getSignatures("w"));
  await assert.rejects(() => pool.getSignatures("w"));
  await assert.rejects(() => pool.getSignatures("w"));
  assert.equal(pool.getStats().circuits["primary"]!.state, "OPEN");

  // 4th call while OPEN and cooldown not elapsed -> rejected without trying provider
  await assert.rejects(() => pool.getSignatures("w"));

  // After cooldown, half-open probe: primary now succeeds (failCount exhausted) -> CLOSED again
  await new Promise((r) => setTimeout(r, 80));
  const sigs = await pool.getSignatures("w");
  assert.ok(sigs.length >= 1);
  assert.equal(pool.getStats().circuits["primary"]!.state, "CLOSED");
});

test("prefers faster measured provider over slower one", async () => {
  const slow = fakeProvider("slow", { latencyMs: 50, fail: true, failCount: 1 });
  const fast = fakeProvider("fast", { latencyMs: 1 });
  const pool = new ProviderPool({
    providers: [slow, fast],
    failureThreshold: 3,
    cooldownMs: 100
  });

  // First call: slow fails once, fast succeeds and becomes measured
  const sigs = await pool.getSignatures("w");
  assert.equal(sigs[0]!.signature.startsWith("sig-fast"), true);

  // Subsequent calls: fast has lower latency and recent success -> preferred
  for (let i = 0; i < 3; i++) {
    await pool.getSignatures("w");
  }
  const stats = pool.getStats();
  assert.ok(stats.circuits["slow"]!.errorRate > 0, "slow should have recorded failures");
  assert.equal(stats.lastProvider, "fast");
});

test("all providers failing throws a meaningful error", async () => {
  const pool = new ProviderPool({
    providers: [fakeProvider("a", { fail: true }), fakeProvider("b", { fail: true })],
    failureThreshold: 1,
    cooldownMs: 1000
  });
  await assert.rejects(() => pool.getSignatures("w"), /all providers failed|429/);
});
