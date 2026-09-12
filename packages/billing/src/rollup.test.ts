import assert from "node:assert/strict";
import { test } from "node:test";
import { rollUpUsage } from "./rollup.js";

test("storage counters roll up into billing dimensions", () => {
  const usage = rollUpUsage({
    records: [
      { usage_type: "expensive_analysis", units: 7 },
      { usage_type: "comparison", units: 2 },
      { usage_type: "ask_aegix", units: 3 },
      { usage_type: "ask_markets", units: 1 }
    ],
    apiUnits: 40,
    activeMonitors: 2
  });

  assert.deepEqual(usage, [
    { dimension: "WALLET_ANALYSIS", units: 7 },
    { dimension: "COMPARISON", units: 2 },
    { dimension: "ASK_AEGIX", units: 3 },
    { dimension: "ASK_AEGIX", units: 1 },
    { dimension: "API_CALLS", units: 40 },
    { dimension: "MONITORED_WALLETS", units: 2 }
  ]);
});

test("cache hits and unknown usage types are dropped, not billed", () => {
  const usage = rollUpUsage({
    records: [
      { usage_type: "cache_hit", units: 500 },
      { usage_type: "something_new", units: 9 }
    ],
    apiUnits: 0,
    activeMonitors: 0
  });
  assert.deepEqual(
    usage.map((u) => u.dimension),
    ["API_CALLS", "MONITORED_WALLETS"]
  );
});

test("API calls and monitors are always reported, even at zero", () => {
  const usage = rollUpUsage({ records: [], apiUnits: 0, activeMonitors: 0 });
  assert.equal(usage.length, 2);
  assert.equal(usage.every((u) => u.units === 0), true);
});
