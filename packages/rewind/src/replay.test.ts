import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplay, RewindError, type CaptureRecord, type CapturedSignal } from "./replay.js";
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

test("context captures are admitted under the same window and lock, one entry per subject and signal", () => {
  const around = (id: string, hoursBefore: number, subject: string, types: string[]) => ({ ...capture(id, hoursBefore, types), domain: "NARRATIVE", subject, label: `${subject} news coverage` });
  const result = buildReplay({ subject: "SOL", eventTime: EVENT, lookbackHours: 24, requestedAt: NOW, captures: [capture("own", 5, [])], context: [
    around("late", -1, "copper", ["NARRATIVE_ACCELERATION"]),
    around("second", 6, "copper", ["NARRATIVE_ACCELERATION"]),
    around("first", 20, "copper", ["NARRATIVE_ACCELERATION"]),
    around("other", 3, "uranium", ["NARRATIVE_ACCELERATION"]),
    around("old", 40, "uranium", ["NARRATIVE_ACCELERATION"])
  ] });
  assert.deepEqual(result.context.map((c) => [c.subject, c.captures, c.leadSeconds]), [["copper", 2, 20 * 3600], ["uranium", 1, 3 * 3600]]);
  assert.equal(result.context[0]!.lastObservedAt, new Date(Date.parse(EVENT) - 6 * 3_600_000).toISOString());
  assert.equal(result.verdict, "NOTHING_OBSERVED", "what the news was doing is not a signal on the subject");
  assert.ok(result.limitations.some((l) => l.includes("surroundings")));
});
