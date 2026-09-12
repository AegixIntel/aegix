import assert from "node:assert/strict";
import { test } from "node:test";
import { COINPAPRIKA_IDS, createCoinPaprikaProvider } from "./provider.js";
import { CANONICAL_ASSETS, MarketError } from "./types.js";
const now = new Date("2026-09-12T10:00:00Z");
test("canonical BTC ETH SOL map to provider IDs, normalize quotes and bounded history", async () => {
  const urls: string[] = [];
  const provider = createCoinPaprikaProvider({ now: () => now, fetchImpl: (async (input) => {
    const url = String(input); urls.push(url);
    const asset = CANONICAL_ASSETS.find((a) => url.includes(COINPAPRIKA_IDS[a]))!;
    return Response.json(url.includes("historical") ? [
      { timestamp: "2026-09-12T09:00:00Z", price: 100, volume_24h: 200 },
      { timestamp: "2026-09-10T00:00:00Z", price: 90, volume_24h: 200 }
    ] : { id: COINPAPRIKA_IDS[asset], symbol: asset, last_updated: now.toISOString(), quotes: { USD: { price: 101, volume_24h: 300, market_cap: 1000, percent_change_24h: 1 } } });
  }) as typeof fetch });
  for (const asset of CANONICAL_ASSETS) {
    const quote = await provider.getQuote(asset);
    assert.equal(quote.asset, asset); assert.equal(quote.priceUsd, 101); assert.equal(quote.freshness.status, "FRESH");
    const history = await provider.getHistory(asset, 1000);
    assert.equal(history.length, 1); assert.equal(history[0]!.volumeUsd, 200);
  }
  assert.ok(urls.every((url) => !url.includes("key=")));
  assert.ok(urls.filter((url) => url.includes("historical")).every((url) => new URL(url).searchParams.get("limit") === "24"));
});
test("provider rejects identity substitutions and malformed prices", async () => {
  const provider = createCoinPaprikaProvider({ fetchImpl: (async () => Response.json({ id: "sol-solana", symbol: "SOL", quotes: { USD: { price: 1 } } })) as typeof fetch });
  await assert.rejects(provider.getQuote("BTC"), (e) => e instanceof MarketError && e.code === "MALFORMED_RESPONSE");
});
test("provider reports rate limits and timeout without leaking response bodies", async () => {
  const limited = createCoinPaprikaProvider({ fetchImpl: (async () => new Response("private provider detail", { status: 429 })) as typeof fetch });
  await assert.rejects(limited.getQuote("SOL"), (e) => e instanceof MarketError && e.code === "RATE_LIMIT" && !e.message.includes("private"));
  const timeout = createCoinPaprikaProvider({ timeoutMs: 5, fetchImpl: ((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch });
  await assert.rejects(timeout.getQuote("SOL"), (e) => e instanceof MarketError && e.code === "TIMEOUT");
});
