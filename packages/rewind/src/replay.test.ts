import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplay, RewindError, type CaptureRecord, type CapturedSignal } from "./replay.js";
import { reconstructCaptures } from "./reconstruct.js";
import { marketSeries, marketSeriesKey } from "./series.js";

const EVENT = "2026-09-20T12:00:00.000Z";
const NOW = "2026-09-25T00:00:00.000Z";

function signal(type: string): CapturedSignal {
  return { type, severity: 50, confidence: 0.7, title: type, summary: type, evidence: [], engineVersion: "markets-v1.0.0" };
}
function capture(id: string, hoursBefore: number, types: string[], extra: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id, observedAt: new Date(Date.parse(EVENT) - hoursBefore * 3_600_000).toISOString(),
    engineVersion: "markets-v1.0.0", qualityGrade: "HIGH", providerStatus: "OK", signals: types.map(signal), ...extra
  };
}

test("captures at or after the event time are never admitted", () => {
  const result = buildReplay({ subject: "SOL", eventTime: EVENT, lookbackHours: 72, requestedAt: NOW, captures: [
    capture("before", 5, ["VOLUME_SPIKE"]),
    capture("at", 0, ["VOLUME_SPIKE", "MOMENTUM", "ANOMALY"]),
    capture("after", -3, ["VOLUME_SPIKE", "MOMENTUM", "ANOMALY"]),
    capture("too-old", 100, ["MOMENTUM"])
  ] });
  assert.deepEqual(result.timeline.map((c) => c.id), ["before"]);
  assert.equal(result.coverage.excludedByLock, 3);
  assert.equal(result.convergence, null, "the convergence stored at the event itself is hindsight");
  assert.equal(result.verdict, "SIGNALS_OBSERVED");
});

test("convergence is the earliest capture holding three distinct signal types", () => {
  const result = buildReplay({ subject: "SOL", eventTime: EVENT, lookbackHours: 72, requestedAt: NOW, captures: [
    capture("a", 60, []),
    capture("b", 40, ["VOLUME_SPIKE"]),
    capture("c", 7.7, ["VOLUME_SPIKE", "MOMENTUM", "VOLATILITY_EXPANSION"]),
    capture("d", 2, ["VOLUME_SPIKE", "MOMENTUM", "VOLATILITY_EXPANSION", "ANOMALY"])
  ] });
  assert.equal(result.verdict, "CONVERGENCE_OBSERVED");
  assert.equal(result.convergence?.captureId, "c");
  assert.equal(result.convergence?.leadSeconds, Math.round(7.7 * 3600));
  assert.equal(result.firstSignal?.captureId, "b");
  assert.deepEqual(result.checkpoints.map((c) => c.label), ["T−72h", "T−48h", "T−24h", "T−8h", "T−2h"]);
  assert.deepEqual(result.checkpoints.map((c) => c.signalTypesSoFar.length), [0, 0, 1, 1, 4]);
  assert.match(result.answer, /7h 42m before the event/);
});

test("no capture in the window is reported as missing record, not as a quiet market", () => {
  const result = buildReplay({ subject: "BTC", eventTime: EVENT, lookbackHours: 24, requestedAt: NOW, captures: [] });
  assert.equal(result.verdict, "NO_COVERAGE");
  assert.match(result.answer, /absence of record/);
});

test("captures with no signal are coverage, and say so", () => {
  const result = buildReplay({ subject: "BTC", eventTime: EVENT, lookbackHours: 24, requestedAt: NOW,
    captures: [capture("a", 20, []), capture("b", 10, [])] });
  assert.equal(result.verdict, "NOTHING_OBSERVED");
  assert.equal(result.coverage.captures, 2);
  assert.equal(result.coverage.largestGapSeconds, 36_000);
  assert.ok(result.limitations.some((l) => l.includes("largest gap")));
});

test("the engine versions shown are the stored ones", () => {
  const result = buildReplay({ subject: "ETH", eventTime: EVENT, lookbackHours: 24, requestedAt: NOW,
    captures: [capture("a", 20, ["MOMENTUM"], { engineVersion: "markets-v0.9.0" }), capture("b", 10, [])] });
  assert.deepEqual(result.engineVersions, ["markets-v0.9.0", "markets-v1.0.0"]);
});

test("a future event, a bad timestamp and an unbounded lookback are refused", () => {
  const base = { subject: "SOL", captures: [], requestedAt: NOW };
  assert.throws(() => buildReplay({ ...base, eventTime: "2026-10-01T00:00:00Z", lookbackHours: 72 }), (e) => e instanceof RewindError && e.code === "EVENT_IN_FUTURE");
  assert.throws(() => buildReplay({ ...base, eventTime: "yesterday", lookbackHours: 72 }), (e) => e instanceof RewindError && e.code === "INVALID_EVENT_TIME");
  assert.throws(() => buildReplay({ ...base, eventTime: EVENT, lookbackHours: 100_000 }), (e) => e instanceof RewindError && e.code === "INVALID_LOOKBACK");
});

test("a discovery stamped at or after the event is not shown, and an earlier one keeps its lead", () => {
  const discovery = (id: string, hoursBefore: number) => ({
    id, detectedAt: new Date(Date.parse(EVENT) - hoursBefore * 3_600_000).toISOString(), status: "CANDIDATE", title: id,
    seriesA: "market:SOL:price_usd", seriesB: "market:BTC:price_usd", lagHours: 0, direction: "POSITIVE", engineVersion: "discovery-v1.0.0"
  });
  const result = buildReplay({ subject: "SOL", eventTime: EVENT, lookbackHours: 24, requestedAt: NOW, captures: [],
    discoveries: [discovery("AEX-3", -1), discovery("AEX-2", 0), discovery("AEX-1", 200)] });
  assert.deepEqual(result.discoveries.map((d) => d.id), ["AEX-1"], "older than the window is still on record; at or after the event is hindsight");
  assert.equal(result.discoveries[0]!.leadSeconds, 200 * 3600);
  assert.equal(result.verdict, "NO_COVERAGE", "a discovery does not stand in for a capture");
});

test("series keys name the measurement, not the provider", () => {
  assert.equal(marketSeriesKey("SOL", "price_usd"), "market:SOL:price_usd");
  assert.equal(marketSeries(["BTC", "ETH"]).length, 4);
});

test("a reconstruction gives each hour only that hour and the ones before it, from one provider", () => {
  const start = Date.parse("2026-09-20T00:00:00.000Z");
  const point = (hour: number, value: number, source: string) => ({ eventTime: new Date(start + hour * 3_600_000 + 60_000).toISOString(), value, source });
  const seen: Array<{ current: number; history: number[]; volume: number | null }> = [];
  const result = reconstructCaptures({
    from: new Date(start + 2 * 3_600_000).toISOString(),
    to: new Date(start + 6 * 3_600_000).toISOString(),
    price: [0, 1, 2, 3, 4, 5, 6, 7].map((h) => point(h, 100 + h, "a")).concat([point(4, 900, "b"), point(5, 901, "b")]),
    volume: [point(3, 50, "a")],
    engineVersion: "markets-test",
    compute: (step) => {
      seen.push({ current: step.currentPrice, history: step.history.map((h) => h.priceUsd), volume: step.currentVolume });
      return step.currentPrice === 103 ? [signal("MOMENTUM")] : [];
    }
  });
  assert.deepEqual(seen, [
    { current: 102, history: [100, 101], volume: null },
    { current: 103, history: [100, 101, 102], volume: 50 },
    { current: 104, history: [100, 101, 102, 103], volume: null }
  ], "the provider with more history behind the hour is read, and hours 5 and later are not stamped before the end");
  assert.deepEqual(result.captures.map((c) => [c.observedAt, c.providerStatus, c.signals.length]), [
    ["2026-09-20T03:00:00.000Z", "RECONSTRUCTED", 0], ["2026-09-20T04:00:00.000Z", "RECONSTRUCTED", 1], ["2026-09-20T05:00:00.000Z", "RECONSTRUCTED", 0]
  ]);
  assert.deepEqual(result.sources, ["a"]);
  assert.equal(result.hours, 3);
  assert.ok(result.captures.every((c) => c.id.startsWith("reconstructed:") && c.qualityGrade === "LOW"));
});

test("hours with no price are not reconstructed", () => {
  const result = reconstructCaptures({ from: "2026-09-20T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z", price: [], volume: [], engineVersion: "x", compute: () => [] });
  assert.deepEqual(result, { captures: [], sources: [], hours: 0 });
});
