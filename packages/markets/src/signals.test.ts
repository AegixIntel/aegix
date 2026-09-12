import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMarketSignals } from "./signals.js";
const history = [100, 100.01, 99.99, 100.01, 99.99, 105, 95, 110, 90, 120, 80, 140].map((priceUsd, i) => ({ timestamp: new Date(Date.UTC(2026, 8, 12, i)).toISOString(), priceUsd, volumeUsd: 100 }));
test("all five signals are deterministic measurements with stable IDs and evidence", () => {
  const input = { asset: "SOL" as const, currentPrice: 200, currentVolume: 1000, history };
  const signals = computeMarketSignals(input);
  assert.deepEqual(signals.map((s) => s.type).sort(), ["ANOMALY", "MOMENTUM", "PRICE_DEVIATION", "VOLATILITY_EXPANSION", "VOLUME_SPIKE"]);
  assert.deepEqual(signals, computeMarketSignals(input));
  assert.deepEqual(signals, computeMarketSignals({ ...input, history: [...history].reverse() }));
  assert.ok(signals.every((s) => s.id === `sig:market:SOL:${s.type}` && s.evidence.length && s.engineVersion && s.confidence > 0));
  assert.ok(!signals.some((s) => /\b(buy|sell|long|short)\b/i.test(s.summary)));
});
test("insufficient history suppresses distribution indicators and missing volume suppresses volume spike", () => {
  assert.deepEqual(computeMarketSignals({ asset: "BTC", currentPrice: 200, currentVolume: 1000, history: history.slice(0, 6) }), []);
  assert.ok(!computeMarketSignals({ asset: "ETH", currentPrice: 200, currentVolume: null, history }).some((s) => s.type === "VOLUME_SPIKE"));
});
