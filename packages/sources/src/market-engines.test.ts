import assert from "node:assert/strict";
import { test } from "node:test";
import { ANOMALY_ENGINE_VERSION, ANOMALY_Z_THRESHOLD, computeSeriesAnomaly, hourlyChanges, type SourcedPoint } from "./anomaly.js";
import { buildNarrativeRadar, readNarrativeTopic } from "./narrative-radar.js";
import { buildSignalFeed, type FeedCapture, type MarketClass, type SignalDomain } from "./signal-feed.js";
import { buildCrossMarketView, type CrossMarketSeries } from "./cross-market.js";
import type { LedgerPoint } from "./context-signals.js";

const HOUR = 3_600_000;
// 2026-10-06 18:30 UTC: a Tuesday, 14:30 in New York.
const AT = new Date("2026-10-06T18:30:00.000Z");
const CURRENT_HOUR = Math.floor(AT.getTime() / HOUR);

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

/** An hourly price path ending in the last completed hour, from log-changes, oldest first. */
function path(changes: number[], source = "fixture", endHour = CURRENT_HOUR - 1): SourcedPoint[] {
  let level = 100;
  const start = endHour - changes.length;
  return [{ eventTime: new Date(start * HOUR).toISOString(), value: level, source },
    ...changes.map((change, i) => { level *= Math.exp(change); return { eventTime: new Date((start + 1 + i) * HOUR).toISOString(), value: level, source }; })];
}
function noise(seed: number, length: number, scale = 0.004): number[] {
  const next = rng(seed);
  return Array.from({ length }, () => (next() - 0.5) * 2 * scale);
}

// ---- Anomaly Detection ----

test("an hourly change far outside the series' own two weeks is an anomaly, with its direction", () => {
  const up = computeSeriesAnomaly({ label: "SOL price (USD)", points: path([...noise(1, 300), 0.06]), at: AT });
  assert.deepEqual(up.signals.map((s) => s.type), ["SERIES_ANOMALY_UP"]);
  assert.equal(up.signals[0]!.engineVersion, ANOMALY_ENGINE_VERSION);
  assert.equal(up.qualityGrade, "HIGH");
  assert.equal(up.changeHour, new Date((CURRENT_HOUR - 1) * HOUR).toISOString());
  assert.ok(Number(up.signals[0]!.evidence.find((e) => e.key === "robust_z")!.value) >= ANOMALY_Z_THRESHOLD);
  const down = computeSeriesAnomaly({ label: "SOL price (USD)", points: path([...noise(1, 300), -0.06]), at: AT });
  assert.deepEqual(down.signals.map((s) => s.type), ["SERIES_ANOMALY_DOWN"]);
});

test("an ordinary hour is read and is not an anomaly", () => {
  const reading = computeSeriesAnomaly({ label: "SOL price (USD)", points: path(noise(2, 301)), at: AT });
  assert.deepEqual(reading.signals, []);
  assert.equal(reading.qualityGrade, "HIGH");
  assert.notEqual(reading.changeHour, null);
});

test("an earlier spike does not widen the baseline and hide the next one", () => {
  const changes = [...noise(3, 300), 0.06];
  changes[150] = 0.2;
  assert.equal(computeSeriesAnomaly({ label: "x", points: path(changes), at: AT }).signals.length, 1);
});

test("a short or flat baseline is no reading, not a quiet series", () => {
  const short = computeSeriesAnomaly({ label: "x", points: path([...noise(4, 40), 0.5]), at: AT });
  assert.deepEqual({ signals: short.signals, qualityGrade: short.qualityGrade }, { signals: [], qualityGrade: "LOW" });
  assert.notEqual(short.changeHour, null, "the hour was still looked at");
  const flat = computeSeriesAnomaly({ label: "x", points: path([...Array(300).fill(0), 0.5]), at: AT });
  assert.deepEqual({ signals: flat.signals, qualityGrade: flat.qualityGrade }, { signals: [], qualityGrade: "LOW" });
});

test("a series with no recent change, and the hour in progress, are not captured", () => {
  const stale = computeSeriesAnomaly({ label: "x", points: path([...noise(5, 300), 0.06], "fixture", CURRENT_HOUR - 10), at: AT });
  assert.equal(stale.changeHour, null);
  const points = [...path(noise(6, 301)), { eventTime: new Date(CURRENT_HOUR * HOUR + 60_000).toISOString(), value: 500, source: "fixture" }];
  assert.deepEqual(computeSeriesAnomaly({ label: "x", points, at: AT }).signals, [], "the unfinished hour's jump is not read yet");
});

test("two providers' levels are never differenced against each other", () => {
  const a = path(noise(7, 200), "provider-a", CURRENT_HOUR - 101);
  const b = path(noise(8, 100), "provider-b").map((p) => ({ ...p, value: p.value * 1.3 }));
  const changes = hourlyChanges([...a, ...b]);
  assert.equal(changes.has(CURRENT_HOUR - 101), false, "the hour where the provider changes has no change");
  assert.equal(changes.has(CURRENT_HOUR - 100), true);
  assert.ok([...changes.values()].every((c) => Math.abs(c.change) < 0.01));
});

// ---- Narrative Radar ----

const TOPICS = [{ id: "copper", label: "Copper", query: "copper" }, { id: "uranium", label: "Uranium", query: "uranium" }, { id: "bitcoin", label: "Bitcoin", query: "bitcoin" }];
/** Hourly counts ending at the newest settled hour, oldest first. */
function counts(values: number[]): LedgerPoint[] {
  const newest = CURRENT_HOUR - 2;
  return values.map((value, i) => ({ eventTime: new Date((newest - (values.length - 1 - i)) * HOUR).toISOString(), value }));
}

test("a topic is accelerating, fading or steady against its own two days", () => {
  const read = (values: number[]) => readNarrativeTopic({ topic: TOPICS[0]!, points: counts(values), at: AT });
  const fast = read([...Array(48).fill(5), ...Array(6).fill(12)]);
  assert.deepEqual([fast.state, fast.ratio, fast.recentMean, fast.baselineMean], ["ACCELERATING", 2.4, 12, 5]);
  assert.equal(read([...Array(48).fill(10), ...Array(6).fill(4)]).state, "FADING");
  assert.equal(read(Array(54).fill(8)).state, "STEADY");
  assert.equal(read([...Array(48).fill(1), ...Array(6).fill(2)]).state, "STEADY", "a doubling of almost nothing is not an acceleration");
  assert.equal(fast.series.length, 54);
});

test("too few hours on record is insufficient data, and the radar lists the moving topics first", () => {
  const points = new Map<string, LedgerPoint[]>([
    ["copper", counts(Array(54).fill(8))],
    ["uranium", counts([...Array(48).fill(5), ...Array(6).fill(15)])]
  ]);
  const radar = buildNarrativeRadar({ topics: TOPICS, points, at: AT });
  assert.deepEqual(radar.map((entry) => [entry.topic, entry.state]), [["uranium", "ACCELERATING"], ["copper", "STEADY"], ["bitcoin", "INSUFFICIENT_DATA"]]);
  assert.deepEqual([radar[2]!.recentMean, radar[2]!.latestHour, radar[2]!.series], [null, null, []]);
});

// ---- Signal Engine ----

const resolve = (domain: SignalDomain, subject: string): { marketClass: MarketClass; label: string } => ({
  label: subject,
  marketClass: domain === "NARRATIVE" ? "NEWS" : domain === "SECTOR" ? "SECTOR_FUND" : subject.endsWith("x") ? "TOKENIZED_EQUITY" : subject === "odd" ? "OTHER" : "CRYPTO"
});
function capture(id: string, domain: SignalDomain, subject: string, hoursAgo: number, type = "T", severity = 50): FeedCapture {
  return { id, domain, subject, observedAt: new Date(AT.getTime() - hoursAgo * HOUR).toISOString(), signals: [{ type, severity, confidence: 1, title: `${subject} ${severity}`, summary: "" }] };
}

test("the feed keeps one entry per subject and signal type, newest first, with the peak", () => {
  const feed = buildSignalFeed({ resolve, captures: [
    capture("1", "MARKET", "SOL", 5, "MOMENTUM", 40), capture("2", "MARKET", "SOL", 3, "MOMENTUM", 70), capture("3", "MARKET", "SOL", 1, "MOMENTUM", 55),
    capture("4", "NARRATIVE", "copper", 2, "NARRATIVE_ACCELERATION", 60)
  ] });
  assert.deepEqual(feed.entries.map((e) => [e.subject, e.signalType, e.captures, e.peakSeverity, e.title]),
    [["SOL", "MOMENTUM", 3, 70, "SOL 70"], ["copper", "NARRATIVE_ACCELERATION", 1, 60, "copper 60"]]);
  assert.equal(feed.capturesRead, 4);
  assert.deepEqual(feed.confluences, [], "two market classes are not a confluence");
});

test("three market classes inside the window are one confluence; the same three spread out are none", () => {
  const close = buildSignalFeed({ resolve, captures: [
    capture("1", "MARKET", "SOL", 9), capture("2", "NARRATIVE", "copper", 7), capture("3", "SECTOR", "XLU", 5), capture("4", "MARKET", "NVDAx", 4),
    capture("5", "MARKET", "odd", 4)
  ] });
  assert.equal(close.confluences.length, 1);
  assert.deepEqual(close.confluences[0]!.classes, ["CRYPTO", "NEWS", "SECTOR_FUND", "TOKENIZED_EQUITY"]);
  assert.deepEqual(close.confluences[0]!.subjects.map((s) => s.subject), ["SOL", "copper", "XLU", "NVDAx"], "a subject outside the market classes is not counted");
  const apart = buildSignalFeed({ resolve, captures: [capture("1", "MARKET", "SOL", 30), capture("2", "NARRATIVE", "copper", 20), capture("3", "SECTOR", "XLU", 10)] });
  assert.deepEqual(apart.confluences, []);
});

test("confluences more than a window apart are separate, newest first", () => {
  const moment = (hoursAgo: number, tag: string) => [
    capture(`${tag}1`, "MARKET", "SOL", hoursAgo + 2), capture(`${tag}2`, "NARRATIVE", "copper", hoursAgo + 1), capture(`${tag}3`, "SECTOR", "XLU", hoursAgo)
  ];
  const feed = buildSignalFeed({ resolve, captures: [...moment(40, "a"), ...moment(4, "b")] });
  assert.equal(feed.confluences.length, 2);
  assert.ok(feed.confluences[0]!.from > feed.confluences[1]!.to);
});

// ---- Cross-Market Intelligence ----

function series(symbol: string, marketClass: CrossMarketSeries["marketClass"], points: SourcedPoint[], session = false): CrossMarketSeries {
  return { key: symbol, symbol, label: symbol, marketClass, session, points };
}
/** A path whose last 24 hours add up to `dayPercent`, on top of noise shared by the class. */
function moved(dayPercent: number, shared: number[], seed: number): SourcedPoint[] {
  const own = noise(seed, shared.length, 0.001);
  const drift = Math.log(1 + dayPercent / 100) / 24;
  return path(shared.map((value, i) => value + own[i]! + (i >= shared.length - 24 ? drift : 0)), "fixture", CURRENT_HOUR);
}

test("classes get returns, breadth and a week of correlation; opposite days are a divergence", () => {
  const crypto = noise(11, 200);
  const equities = noise(12, 200);
  const view = buildCrossMarketView({ at: AT, series: [
    series("BTC", "CRYPTO", moved(3, crypto, 1)), series("ETH", "CRYPTO", moved(4, crypto, 2)), series("SOL", "CRYPTO", moved(5, crypto, 3)),
    series("NVDAx", "TOKENIZED_EQUITY", moved(-2, equities, 4)), series("TSLAx", "TOKENIZED_EQUITY", moved(-3, equities, 5)),
    series("AAPLx", "TOKENIZED_EQUITY", [])
  ] });
  const [cryptoClass, equityClass] = view.classes;
  assert.deepEqual([cryptoClass!.marketClass, cryptoClass!.measured, cryptoClass!.advancing], ["CRYPTO", 3, 3]);
  assert.deepEqual([equityClass!.measured, equityClass!.advancing], [2, 0], "a member with no price is listed and not measured");
  assert.equal(equityClass!.members.find((m) => m.symbol === "AAPLx")!.price, null);
  assert.ok(cryptoClass!.median24hPercent! > 1 && equityClass!.median24hPercent! < -1);
  assert.notEqual(cryptoClass!.median7dPercent, null);
  assert.equal(view.correlations.length, 1);
  assert.ok(view.correlations[0]!.pairedHours >= 96 && Math.abs(view.correlations[0]!.r!) < 0.5, "independent classes are not strongly correlated");
  assert.deepEqual(view.readings.map((r) => r.type), ["CLASS_DIVERGENCE"]);
});

test("classes that share their moves correlate, and a short record gives no correlation", () => {
  const shared = noise(13, 200);
  const together = buildCrossMarketView({ at: AT, series: [series("BTC", "CRYPTO", moved(0, shared, 1)), series("NVDAx", "TOKENIZED_EQUITY", moved(0, shared, 2))] });
  assert.ok(together.correlations[0]!.r! > 0.8);
  const brief = noise(14, 50);
  const short = buildCrossMarketView({ at: AT, series: [series("BTC", "CRYPTO", moved(0, brief, 1)), series("NVDAx", "TOKENIZED_EQUITY", moved(0, brief, 2))] });
  assert.equal(short.correlations[0]!.r, null);
  assert.equal(short.classes[0]!.median7dPercent, null, "a week-ago price that is not on record gives no weekly return");
});

test("a stale price is not now, and sector funds are ranked against their median", () => {
  const stale = buildCrossMarketView({ at: AT, series: [series("BTC", "CRYPTO", path(noise(15, 100), "fixture", CURRENT_HOUR - 8))] });
  assert.equal(stale.classes[0]!.members[0]!.price, null);
  const fund = (symbol: string, percent: number) => series(symbol, "SECTOR_FUND", [
    { eventTime: "2026-10-05T20:03:00.000Z", value: 100 }, { eventTime: "2026-10-06T18:03:00.000Z", value: 100 + percent }], true);
  const view = buildCrossMarketView({ at: AT, series: [fund("XLK", 0.2), fund("XLU", 2.2), fund("XLE", -1.8)] });
  assert.deepEqual(view.sectors.map((s) => [s.symbol, s.dayReturnPercent, s.excessPoints]), [["XLU", 2.2, 2], ["XLK", 0.2, 0], ["XLE", -1.8, -2]]);
  assert.deepEqual([view.classes[0]!.session, view.classes[0]!.members[0]!.return7dPercent], [true, null]);
  assert.deepEqual(view.correlations, [], "session classes are not correlated hour by hour");
});

test("most of what is priced around the clock moving one way is a broad advance", () => {
  const shared = noise(16, 200);
  const view = buildCrossMarketView({ at: AT, series: Array.from({ length: 9 }, (_, i) => series(`S${i}`, i < 3 ? "CRYPTO" : "TOKENIZED_EQUITY", moved(i === 8 ? -1 : 2, shared, 20 + i))) });
  assert.deepEqual(view.readings.map((r) => r.type), ["BROAD_ADVANCE"]);
});

test("a series that stands still most hours is measured against the hours it moved", () => {
  // Three hours in four flat: the median deviation is zero, and v1.0.0 either refused the series or scored it in the thousands.
  const baseline = Array.from({ length: 300 }, (_, i) => (i % 4 === 0 ? (i % 8 === 0 ? 0.004 : -0.004) : 0));
  const large = computeSeriesAnomaly({ label: "HOODx on-chain price (USDC)", points: path([...baseline, 0.015]), at: AT });
  assert.equal(large.signals[0]?.type, "SERIES_ANOMALY_UP");
  const evidence = Object.fromEntries(large.signals[0]!.evidence.map((e) => [e.key, e.value]));
  assert.ok(Number(evidence.robust_z) > ANOMALY_Z_THRESHOLD && Number(evidence.robust_z) < 20, `a 1.5% hour is ${evidence.robust_z} deviations, not thousands`);
  assert.ok(Number(evidence.typical_move_percent) > 0.1, "and the typical move stated is one the series makes");
  const usual = computeSeriesAnomaly({ label: "HOODx on-chain price (USDC)", points: path([...baseline, 0.004]), at: AT });
  assert.deepEqual([usual.signals.length, usual.qualityGrade], [0, "HIGH"], "a move it makes every few hours is read and is not an anomaly");
});
