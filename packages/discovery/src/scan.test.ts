import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAILY_PROFILE, DISCOVERY_FDR_LEVEL, DISCOVERY_LAGS_HOURS, DISCOVERY_WINDOW_HOURS,
  epochEndFor, hourlyLogChanges, logChanges, pairKey, runScan, scanHorizonHours, type SeriesInput
} from "./scan.js";
import { benjaminiYekutieli, correlationPValue, effectiveSampleSize, normalCdf, pearson } from "./stats.js";

const HOUR = 3_600_000;
const EPOCH_END = "2026-09-29T00:00:00.000Z";
const END_HOUR = Date.parse(EPOCH_END) / HOUR;
const HOURS = 400;

/** Deterministic generator, so a failing case can be replayed exactly. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function gaussian(next: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
}
function noise(seed: number, scale = 0.01): number[] {
  const next = rng(seed);
  return Array.from({ length: HOURS }, () => gaussian(next) * scale);
}
/** Turns hourly log-changes into a level series ending at the epoch boundary. */
function series(key: string, changes: number[], endHour = END_HOUR): SeriesInput {
  let level = 100;
  const points = changes.map((change, i) => {
    level *= Math.exp(change);
    return { eventTime: new Date((endHour - changes.length + i) * HOUR).toISOString(), value: level };
  });
  return { key, label: key, group: key.split(":")[0]!, points };
}
/** b follows a by `lag` hours, but only inside the last `hours` of the series. */
function coupled(a: number[], seed: number, lag: number, hours: number, sign = 1): number[] {
  const own = noise(seed);
  return own.map((value, i) => (i >= HOURS - hours && i - lag >= 0 ? sign * a[i - lag]! + value * 0.3 : value));
}

test("gaps stay gaps: a change needs two consecutive hours", () => {
  const changes = hourlyLogChanges([
    { eventTime: "2026-09-01T00:10:00Z", value: 100 },
    { eventTime: "2026-09-01T01:10:00Z", value: 110 },
    { eventTime: "2026-09-01T03:10:00Z", value: 120 },
    { eventTime: "2026-09-01T04:10:00Z", value: 0 }
  ]);
  assert.equal(changes.size, 1);
  assert.ok(Math.abs([...changes.values()][0]! - Math.log(1.1)) < 1e-12);
});

test("Benjamini–Yekutieli q-values are monotone and carry the harmonic factor", () => {
  const q = benjaminiYekutieli([0.01, 0.04, 0.03, 0.005]);
  const c = 1 + 1 / 2 + 1 / 3 + 1 / 4;
  assert.ok(Math.abs(q[3]! - 0.005 * 4 * c) < 1e-12);
  assert.ok(Math.abs(q[0]! - 0.005 * 4 * c) < 1e-12);
  assert.ok(Math.abs(q[1]! - 0.04 * c) < 1e-12);
  assert.ok(Math.abs(q[2]! - 0.04 * c) < 1e-12);
  assert.deepEqual(benjaminiYekutieli([]), []);
});

test("autocorrelated series get a smaller effective sample and a larger p-value", () => {
  const next = rng(7);
  const a: number[] = []; const b: number[] = [];
  let x = 0; let y = 0;
  for (let i = 0; i < 300; i++) { x = 0.9 * x + gaussian(next); y = 0.9 * y + gaussian(next); a.push(x); b.push(y); }
  const nEff = effectiveSampleSize(a, b);
  assert.ok(nEff < 300 / 3, `n_eff ${nEff} reflects the autocorrelation`);
  const r = pearson(a, b)!;
  assert.ok(correlationPValue(r, nEff) > correlationPValue(r, 300));
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
});

test("independent series produce no discovery", () => {
  const input = Array.from({ length: 6 }, (_, i) => series(`s${i}:x`, noise(100 + i)));
  const result = runScan({ series: input, epochEnd: EPOCH_END, open: [] });
  assert.equal(result.hypothesesTested, 15 * DISCOVERY_LAGS_HOURS.length);
  assert.equal(result.discoveries.length, 0);
  assert.equal(result.rejections, 0);
});

test("a relationship that appears in the test window is discovered at its lag, once, reproducibly", () => {
  const a = noise(1);
  const input = [series("a:x", a), series("b:x", coupled(a, 2, 2, DISCOVERY_WINDOW_HOURS)), series("c:x", noise(3))];
  const result = runScan({ series: input, epochEnd: EPOCH_END, open: [] });
  assert.equal(result.discoveries.length, 1);
  const found = result.discoveries[0]!;
  assert.equal(found.pairKey, pairKey("a:x", "b:x"));
  assert.equal(found.lagHours, 2);
  assert.equal(found.direction, "POSITIVE");
  assert.ok(found.card.qValue <= DISCOVERY_FDR_LEVEL);
  assert.equal(found.card.confidence, Number((1 - found.card.qValue).toFixed(4)));
  assert.equal(found.card.hypothesesTested, result.hypothesesTested);
  assert.ok(found.card.baseline.maxAbsR < 0.3);
  assert.ok(found.card.contradicting.length > 0, "the lags that found nothing are reported");
  assert.match(found.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(runScan({ series: [...input].reverse(), epochEnd: EPOCH_END, open: [] }), result, "order of input does not change the result");
});

test("a relationship that already existed in the baseline is not new", () => {
  const a = noise(1);
  const result = runScan({ series: [series("a:x", a), series("b:x", coupled(a, 2, 0, HOURS))], epochEnd: EPOCH_END, open: [] });
  assert.equal(result.discoveries.length, 0);
  assert.ok(result.tests.every((t) => t.status === "KNOWN_RELATIONSHIP"));
  assert.equal(result.hypothesesTested, 0);
});

test("without a baseline nothing is tested", () => {
  const a = noise(1).slice(-DISCOVERY_WINDOW_HOURS);
  const b = coupled(noise(1), 2, 0, HOURS).slice(-DISCOVERY_WINDOW_HOURS);
  const result = runScan({ series: [series("a:x", a), series("b:x", b)], epochEnd: EPOCH_END, open: [] });
  assert.ok(result.tests.every((t) => t.status === "INSUFFICIENT_BASELINE"));
  const flat = runScan({ series: [series("a:x", noise(1)), series("b:x", new Array(HOURS).fill(0))], epochEnd: EPOCH_END, open: [] });
  assert.ok(flat.tests.every((t) => t.status === "INSUFFICIENT_BASELINE"), "a series that never moved has no baseline to compare against");
  assert.equal(result.discoveries.length, 0);
});

test("observations at or after the epoch end are never read", () => {
  const a = noise(1);
  const input = [series("a:x", a), series("b:x", coupled(a, 2, 2, DISCOVERY_WINDOW_HOURS))];
  const clean = runScan({ series: input, epochEnd: EPOCH_END, open: [] });
  const future = input.map((s) => ({ ...s, points: [...s.points,
    ...Array.from({ length: 48 }, (_, i) => ({ eventTime: new Date((END_HOUR + i) * HOUR).toISOString(), value: 1 + i * 1000 }))] }));
  assert.deepEqual(runScan({ series: future, epochEnd: EPOCH_END, open: [] }), clean);
});

test("confirmation waits for a disjoint window, then tests the original lag only", () => {
  const key = pairKey("a:x", "b:x");
  const a = noise(1);
  const persistent = [series("a:x", a), series("b:x", coupled(a, 2, 2, HOURS))];

  const overlapping = runScan({ series: persistent, epochEnd: EPOCH_END,
    open: [{ pairKey: key, lagHours: 2, direction: "POSITIVE", windowEnd: new Date((END_HOUR - 24) * HOUR).toISOString() }] });
  assert.deepEqual(overlapping.tests.map((t) => t.status), ["AWAITING_CONFIRMATION_WINDOW"]);
  assert.equal(overlapping.confirmations.length, 0);

  const open = [{ pairKey: key, lagHours: 2, direction: "POSITIVE" as const, windowEnd: new Date((END_HOUR - DISCOVERY_WINDOW_HOURS) * HOUR).toISOString() }];
  const confirmed = runScan({ series: persistent, epochEnd: EPOCH_END, open });
  assert.equal(confirmed.tests.length, 1);
  assert.equal(confirmed.confirmations[0]?.eventType, "CONFIRMED");
  assert.equal(confirmed.discoveries.length, 0, "an existing discovery is never issued a second ID");

  const faded = runScan({ series: [series("a:x", a), series("b:x", noise(77))], epochEnd: EPOCH_END, open });
  assert.equal(faded.confirmations[0]?.eventType, "NOT_CONFIRMED");

  const flipped = runScan({ series: [series("a:x", a), series("b:x", coupled(a, 2, 2, HOURS, -1))], epochEnd: EPOCH_END, open });
  assert.equal(flipped.confirmations[0]?.eventType, "NOT_CONFIRMED");
  assert.match(flipped.confirmations[0]!.detail.reason, /changed sign/);
});

test("epochs end on UTC day boundaries and the horizon covers both windows", () => {
  assert.equal(epochEndFor(new Date("2026-09-29T13:45:00Z")).toISOString(), EPOCH_END);
  assert.ok(scanHorizonHours() >= 2 * DISCOVERY_WINDOW_HOURS + 24);
  assert.throws(() => runScan({ series: [], epochEnd: "2026-09-29T00:30:00Z", open: [] }));
});

/** A daily level series: `perDay` readings a day, the last of which carries the day's change. */
function dailySeries(key: string, changes: number[], skipWeekends = false): SeriesInput {
  const DAY = 24 * HOUR;
  const endDay = Date.parse(EPOCH_END) / DAY;
  let level = 100;
  const points: SeriesInput["points"] = [];
  changes.forEach((change, i) => {
    const day = endDay - changes.length + i;
    level *= Math.exp(change);
    const weekday = new Date(day * DAY).getUTCDay();
    if (skipWeekends && (weekday === 0 || weekday === 6)) return;
    // An early reading that the day's last observation must supersede.
    points.push({ eventTime: new Date(day * DAY + 14 * HOUR).toISOString(), value: level * 1.5 });
    points.push({ eventTime: new Date(day * DAY + 20 * HOUR).toISOString(), value: level });
  });
  return { key, label: key, group: key.split(":")[0]!, points };
}

test("the daily scan finds a relationship planted in daily changes, at its lag in days", () => {
  const days = 125;
  const next = rng(11);
  const a = Array.from({ length: days }, () => gaussian(next) * 0.02);
  const own = Array.from({ length: days }, () => gaussian(next) * 0.02);
  // b follows a by two days, in the last sixty days only.
  const b = own.map((value, i) => (i >= days - 60 && i >= 2 ? a[i - 2]! + value * 0.3 : value));
  const scan = runScan({ series: [dailySeries("a:x", a), dailySeries("b:x", b), dailySeries("c:x", own.map((v) => -v).reverse())], epochEnd: EPOCH_END, open: [] }, DAILY_PROFILE);

  assert.equal(scan.engineVersion, DAILY_PROFILE.engineVersion);
  assert.equal(scan.hypothesesConsidered, 3 * DAILY_PROFILE.lagsHours.length);
  const found = scan.discoveries.find((d) => d.pairKey === pairKey("a:x", "b:x"));
  assert.ok(found, "the planted pair is a discovery");
  assert.equal(found.lagHours, 48, "the lag is stored in hours");
  assert.equal(found.direction, "POSITIVE");
  assert.match(found.card.summary, /^Daily changes .* leading b:x by 2d/);
  assert.match(found.card.method, /daily log-change/);
  assert.equal(found.card.window.start, new Date(Date.parse(EPOCH_END) - 60 * 24 * HOUR).toISOString());
  assert.notEqual(found.fingerprint, runScan({ series: [], epochEnd: EPOCH_END, open: [] }).engineVersion);
});

test("a session series has no daily change across a weekend, and too few days is not tested", () => {
  const days = 125;
  const next = rng(5);
  const a = Array.from({ length: days }, () => gaussian(next) * 0.02);
  const b = Array.from({ length: days }, () => gaussian(next) * 0.02);
  const weekdaysOnly = dailySeries("etf:x", a, true);
  const changes = logChanges(weekdaysOnly.points, 24);
  // Five readings a week give four consecutive-day changes.
  assert.ok(changes.size > 60 && changes.size < days * 4 / 7 + 2);
  for (const day of changes.keys()) assert.notEqual(new Date(day * 24 * HOUR).getUTCDay(), 1, "no Monday change: Sunday has no reading");

  const scan = runScan({ series: [weekdaysOnly, dailySeries("b:x", b)], epochEnd: EPOCH_END, open: [] }, DAILY_PROFILE);
  // Sixty days hold about 34 weekday-to-weekday changes, never the full sixty.
  assert.ok(scan.tests.every((t) => t.n <= 36), "pairs are limited to days both series have a change");

  const short = runScan({ series: [dailySeries("a:x", a.slice(-40)), dailySeries("b:x", b.slice(-40))], epochEnd: EPOCH_END, open: [] }, DAILY_PROFILE);
  assert.ok(short.tests.every((t) => t.status === "INSUFFICIENT_BASELINE"));
  assert.equal(short.hypothesesTested, 0);
  assert.throws(() => runScan({ series: [], epochEnd: "2026-09-29T06:00:00Z", open: [] }, DAILY_PROFILE), /whole UTC day/);
  assert.ok(scanHorizonHours(DAILY_PROFILE) >= 120 * 24 + 120);
});
