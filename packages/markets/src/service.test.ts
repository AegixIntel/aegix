import assert from "node:assert/strict";
import { test } from "node:test";
import { createMarketService } from "./service.js";
import { assessFreshness } from "./normalize.js";
import type { MarketDataProvider } from "./types.js";
test("cache coalesces requests and re-evaluates freshness on outage, never refreshing old timestamps", async () => {
  let time = Date.UTC(2026, 8, 12, 10);
  let calls = 0; let outage = false;
  const provider: MarketDataProvider = { name: "fixture",
    async getQuote(asset) { calls++; if (outage) throw new Error("offline");
      return { asset, provider: "fixture", priceUsd: 200, volume24hUsd: 1000, marketCapUsd: null, percentChange24h: null, freshness: assessFreshness(new Date(time).toISOString(), new Date(time)) }; },
    async getHistory() { if (outage) throw new Error("offline");
      return Array.from({ length: 24 }, (_, i) => ({ timestamp: new Date(time - (24 - i) * 3600000).toISOString(), priceUsd: 100 + i % 3, volumeUsd: 100 })); }
  };
  const service = createMarketService({ provider, now: () => new Date(time) });
  const first = await Promise.all(Array.from({ length: 10 }, () => service.getSnapshot("SOL")));
  assert.equal(calls, 1); assert.ok(first[0]!.signals.length > 0);
  await service.getSnapshot("SOL"); assert.equal(calls, 1);
  outage = true; time += 900000;
  const stale = await service.getSnapshot("SOL");
  assert.equal(stale.providerStatus, "DEGRADED"); assert.equal(stale.quote.freshness.status, "STALE"); assert.equal(stale.quality.grade, "LOW");
  time += 3600000;
  const expired = await service.getSnapshot("SOL");
  assert.equal(expired.quote.freshness.status, "UNAVAILABLE"); assert.deepEqual(expired.signals, []);
});
test("history provider failure preserves a quote with explicit degradation and no invented history", async () => {
  const time = new Date("2026-09-12T10:00:00Z");
  const provider: MarketDataProvider = { name: "fixture", async getQuote(asset) { return { asset, provider: "fixture", priceUsd: 1, volume24hUsd: null, marketCapUsd: null, percentChange24h: null, freshness: assessFreshness(time.toISOString(), time) }; }, async getHistory() { throw new Error("offline"); } };
  const service = createMarketService({ provider, now: () => time });
  const result = await service.getSnapshot("BTC");
  assert.equal(result.quote.priceUsd, 1); assert.equal(result.providerStatus, "DEGRADED"); assert.deepEqual(result.history, []); assert.deepEqual(result.signals, []);
  assert.equal((await service.getSnapshot("BTC")).providerStatus, "DEGRADED");
});

test("malformed cache cannot prevent provider access", async () => {
  const time = new Date("2026-09-12T10:00:00Z"); let calls = 0;
  const provider: MarketDataProvider = { name: "fixture", async getQuote(asset) { calls++; return { asset, provider: "fixture", priceUsd: 1, volume24hUsd: null, marketCapUsd: null, percentChange24h: null, freshness: assessFreshness(time.toISOString(), time) }; }, async getHistory() { return []; } };
  const service = createMarketService({ provider, now: () => time, cache: {
    async getJson<T>() { return { fetchedAt: time.getTime(), snapshot: { quote: null } } as T; },
    async setJson() { throw new Error("offline"); }
  } });
  assert.equal((await service.getSnapshot("ETH")).quote.priceUsd, 1); assert.equal(calls, 1);
});
