import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { markNotificationRead, getMarket, askMarket, AskAegixError } from "./api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const status of [401, 404, 500]) {
  test(`markNotificationRead rejects HTTP ${status}`, async () => {
    globalThis.fetch = async () => new Response(null, { status });
    await assert.rejects(() => markNotificationRead("42"), new RegExp(String(status)));
  });
}

test("markNotificationRead resolves only for an OK response", async () => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await markNotificationRead("42");
});

test("Markets UI reports provider unavailability rather than presenting a zero quote", async () => {
  globalThis.fetch = async () => Response.json({ code: "MARKET_DATA_UNAVAILABLE" }, { status: 503 });
  await assert.rejects(() => getMarket("BTC"), /MARKET_DATA_UNAVAILABLE/);
});
test("market explanation failure remains separate from fetching deterministic market data", async () => {
  globalThis.fetch = async (input) => String(input).endsWith("/ask")
    ? Response.json({ code: "AI_UNAVAILABLE", reason: "TIMEOUT" }, { status: 503 })
    : Response.json({ asset: "SOL", snapshot: { quote: { priceUsd: 100 } } });
  await assert.rejects(() => askMarket("SOL", "Explain observed activity"), (error) => error instanceof AskAegixError && error.detail.reason === "TIMEOUT");
  assert.equal((await getMarket("SOL")).snapshot.quote.priceUsd, 100);
});
