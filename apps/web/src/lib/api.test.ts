import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  markNotificationRead,
  getMarket,
  askMarket,
  AskAegixError,
  createDeveloperKey,
  rotateDeveloperKey,
  createWebhook,
  getDeveloperUsage
} from "./api.js";

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

// Response envelopes below mirror apps/api. Rendering an unwrapped envelope
// crashed the portal (React error #31: an object rendered as a child).
const createdKey = {
  id: "1",
  name: "ci",
  key: "aegix_live_example",
  keyPrefix: "aegix_live_ex",
  scopes: ["intelligence:read"],
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null
};

test("createDeveloperKey unwraps the API's { key } envelope", async () => {
  globalThis.fetch = async () => Response.json({ key: createdKey }, { status: 201 });
  const result = await createDeveloperKey("ci", ["intelligence:read"]);
  assert.equal(result.key, "aegix_live_example");
});

test("rotateDeveloperKey unwraps the API's { key } envelope", async () => {
  globalThis.fetch = async () => Response.json({ key: createdKey }, { status: 201 });
  const result = await rotateDeveloperKey("1");
  assert.equal(result.key, "aegix_live_example");
});

test("createWebhook unwraps the API's { data } envelope", async () => {
  globalThis.fetch = async () =>
    Response.json({ data: { webhook: { id: "7", url: "https://example.com/hook", status: "ACTIVE", eventTypes: ["monitor.threat.created"] }, secret: "whsec_example" }, meta: { requestId: "r" } }, { status: 201 });
  const result = await createWebhook("https://example.com/hook", ["monitor.threat.created"]);
  assert.equal(result.secret, "whsec_example");
  assert.equal(result.webhook.id, "7");
});

test("getDeveloperUsage reads the session usage endpoint, not the API-key one", async () => {
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return Response.json({ periodStart: "a", periodEnd: "b", used: 3, limit: 500, remaining: 497, resetAt: "b", breakdown: [] });
  };
  const usage = await getDeveloperUsage();
  assert.match(requested, /\/v1\/me\/developer\/usage$/);
  assert.equal(usage.limit, 500);
});
