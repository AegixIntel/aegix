import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { loadConfig } from "@aegix/config";
import { AIError, type AIProvider } from "@aegix/ai";
import { createMarketService, assessFreshness, type MarketDataProvider } from "@aegix/markets";
import { registerMarkets } from "./markets.js";
import { buildServer } from "./server.js";
const now = new Date("2026-09-12T10:00:00Z");
const config = loadConfig({ NODE_ENV: "test" });

test("Markets accepts only canonical identities and requires authenticated users", async () => {
  const app = await buildServer({ config });
  try {
    assert.equal((await app.inject({ url: "/v1/markets/XRP" })).statusCode, 400);
    assert.equal((await app.inject({ url: "/v1/markets/BTC" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/v1/markets" })).statusCode, 401);
  } finally { await app.close(); }
});
test("Markets can be disabled without disabling deterministic wallet utilities", async () => {
  const app = await buildServer({ config: loadConfig({ NODE_ENV: "test", ENABLE_MARKETS: "false" }) });
  try {
    assert.equal((await app.inject({ url: "/v1/markets/ETH" })).statusCode, 403);
    assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);
  } finally { await app.close(); }
});
test("market API normalizes service results, grounds explanations, meters and fails open", async () => {
  const app = Fastify(); let claims = 0; let aiOutage = false;
  const provider: MarketDataProvider = { name: "fixture", async getQuote(asset) { return { asset, priceUsd: 200, volume24hUsd: 1000, marketCapUsd: null, percentChange24h: null, provider: "fixture", freshness: assessFreshness(now.toISOString(), now) }; },
    async getHistory() { return Array.from({ length: 24 }, (_, i) => ({ timestamp: new Date(now.getTime() - (24 - i) * 3600000).toISOString(), priceUsd: 100 + i % 3, volumeUsd: 100 })); } };
  const ai: AIProvider = { name: "fixture", isConfigured: () => true, async generateStructuredResponse(request) {
    if (aiOutage) throw new AIError("MALFORMED_RESPONSE", "invalid");
    assert.ok(request.evidenceBlock.includes("cov:market:BTC:quote"));
    return { answer: { summary: "BUY now", limitations: [], findings: [{ statement: "A bounded market quote is available.", evidenceIds: ["cov:market:BTC:quote", "sig:unknown"] }, { statement: "Invented.", evidenceIds: [] }] },
      model: "fixture", latencyMs: 1, usage: { promptTokens: 3, completionTokens: 4 } };
  } };
  registerMarkets({ app, config, service: createMarketService({ provider, now: () => now }), provider: ai,
    requireUser: async () => ({ id: "user", isAnonymous: false }), loadWalletContext: async () => null,
    claimQuota: async () => ({ allowed: ++claims <= 5, used: claims, limit: 5, resetAt: now.toISOString() }), logger: { info() {}, warn() {} } });
  try {
    const market = await app.inject({ url: "/v1/markets/BTC" });
    assert.equal(market.statusCode, 200); assert.equal(market.json().snapshot.history.length, 24);
    const request = { method: "POST" as const, url: "/v1/markets/BTC/ask", payload: { question: "Explain the market quote." } };
    const answer = await app.inject(request);
    assert.equal(answer.statusCode, 200); assert.equal(answer.json().findingsDropped, 1);
    assert.deepEqual(answer.json().answer.findings[0].evidenceIds, ["cov:market:BTC:quote"]);
    assert.ok(!answer.json().answer.summary.includes("BUY"));
    aiOutage = true; assert.equal((await app.inject(request)).statusCode, 503);
    assert.equal((await app.inject({ url: "/v1/markets/ETH" })).statusCode, 200);
    const all = await app.inject({ url: "/v1/markets" }); assert.equal(all.json().markets.length, 3);
    assert.equal((await app.inject({ url: "/v1/markets/SOL" })).statusCode, 429);
    assert.equal(claims, 6);
  } finally { await app.close(); }
});
test("provider failure isolates unavailable assets in the collection", async () => {
  const app = Fastify();
  registerMarkets({ app, config, service: { async getSnapshot() { throw new Error("private detail"); } },
    provider: { name: "none", isConfigured: () => false, async generateStructuredResponse() { throw new Error(); } },
    requireUser: async () => ({ id: "user", isAnonymous: false }), loadWalletContext: async () => null,
    claimQuota: async () => ({ allowed: true, used: 1, limit: 5, resetAt: "tomorrow" }), logger: { info() {}, warn() {} } });
  try {
    const single = await app.inject({ url: "/v1/markets/SOL" }); assert.equal(single.statusCode, 503); assert.ok(!single.body.includes("private"));
    const all = await app.inject({ url: "/v1/markets" }); assert.equal(all.statusCode, 200); assert.ok(all.json().markets.every((m: { status: string }) => m.status === "UNAVAILABLE"));
    assert.equal((await app.inject({ method: "POST", url: "/v1/markets/SOL/ask", payload: { question: "Explain markets" } })).statusCode, 503);
  } finally { await app.close(); }
});
