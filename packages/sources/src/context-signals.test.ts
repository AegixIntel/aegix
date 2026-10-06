import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_ENGINE_VERSION, computeFundSignals, computeNarrativeSignals, fundDayReturn, type LedgerPoint } from "./context-signals.js";
import { QUOTED_FUNDS } from "./sector-quotes.js";

const HOUR = 3_600_000;
const TOPIC = { id: "copper", label: "Copper", query: "copper" };
// 2026-10-06 18:30 UTC: a Tuesday, 14:30 in New York.
const AT = new Date("2026-10-06T18:30:00.000Z");

/** Hourly counts ending at the newest settled hour, oldest first. */
function hours(values: number[], at = AT): LedgerPoint[] {
  const newest = Math.floor(at.getTime() / HOUR) - 2;
  return values.map((value, i) => ({ eventTime: new Date((newest - (values.length - 1 - i)) * HOUR).toISOString(), value }));
}

test("coverage at twice its baseline is an acceleration, and carries its engine version", () => {
  const reading = computeNarrativeSignals({ topic: TOPIC, points: hours([...Array(48).fill(5), ...Array(6).fill(12)]), at: AT });
  assert.equal(reading.qualityGrade, "HIGH");
  assert.deepEqual(reading.signals.map((s) => s.type), ["NARRATIVE_ACCELERATION"]);
  assert.equal(reading.signals[0]!.engineVersion, CONTEXT_ENGINE_VERSION);
  assert.equal(reading.signals[0]!.evidence.find((e) => e.key === "ratio")?.value, 2.4);
});

test("steady coverage, and a doubling of almost nothing, are not signals", () => {
  assert.deepEqual(computeNarrativeSignals({ topic: TOPIC, points: hours(Array(54).fill(8)), at: AT }).signals, []);
  assert.deepEqual(computeNarrativeSignals({ topic: TOPIC, points: hours([...Array(48).fill(1), ...Array(6).fill(2)]), at: AT }).signals, []);
});

test("too few hours on record is no reading, not a quiet topic", () => {
  const reading = computeNarrativeSignals({ topic: TOPIC, points: hours([...Array(10).fill(5), ...Array(6).fill(50)]), at: AT });
  assert.deepEqual(reading, { signals: [], qualityGrade: "LOW" });
});

test("an hour that is not settled yet is not read", () => {
  const points = [...hours([...Array(48).fill(5), ...Array(6).fill(5)]), { eventTime: new Date(Math.floor(AT.getTime() / HOUR) * HOUR - HOUR).toISOString(), value: 500 }];
  assert.deepEqual(computeNarrativeSignals({ topic: TOPIC, points, at: AT }).signals, []);
});

const YESTERDAY = "2026-10-05T20:03:00.000Z";
const TODAY = "2026-10-06T18:03:00.000Z";
function fundPoints(returnsBySymbol: Record<string, number>): Map<string, LedgerPoint[]> {
  return new Map(Object.entries(returnsBySymbol).map(([symbol, percent]) => [symbol, [
    { eventTime: YESTERDAY, value: 100 }, { eventTime: TODAY, value: 100 * (1 + percent / 100) }
  ]]));
}
const SECTORS = ["XLK", "XLF", "XLE", "XLU", "XLV", "XLI", "XLY", "XLP", "XLB", "XLRE", "XLC"];

test("a sector fund far from the median sector fund is relative strength or weakness", () => {
  const flat = Object.fromEntries(SECTORS.map((symbol) => [symbol, 0.2]));
  const readings = computeFundSignals({ funds: QUOTED_FUNDS, points: fundPoints({ ...flat, XLU: 2.1, XLE: -1.6, URA: 3 }), at: AT });
  assert.deepEqual(readings.get("XLU")!.signals.map((s) => s.type), ["SECTOR_RELATIVE_STRENGTH"]);
  assert.deepEqual(readings.get("XLE")!.signals.map((s) => s.type), ["SECTOR_RELATIVE_WEAKNESS"]);
  assert.deepEqual(readings.get("XLK")!.signals, []);
  assert.deepEqual(readings.get("URA")!.signals.map((s) => s.type), ["FUND_DAILY_MOVE"], "a commodity fund is not ranked against sectors");
  assert.equal(readings.has("GLD"), false, "a fund with no price today has no reading");
});

test("with too few sector funds read, nothing is ranked", () => {
  const readings = computeFundSignals({ funds: QUOTED_FUNDS, points: fundPoints({ XLK: 0, XLF: 0, XLU: 2 }), at: AT });
  assert.deepEqual(readings.get("XLU"), { signals: [], qualityGrade: "MEDIUM", currentAt: TODAY });
});

test("a fund's day needs today's price and the previous session's", () => {
  assert.equal(fundDayReturn([{ eventTime: TODAY, value: 100 }], AT), null);
  assert.equal(fundDayReturn([{ eventTime: "2026-09-20T20:00:00.000Z", value: 90 }, { eventTime: TODAY, value: 100 }], AT), null, "a price from weeks ago is not the previous session");
  assert.equal(fundDayReturn([{ eventTime: YESTERDAY, value: 100 }, { eventTime: "2026-10-06T19:00:00.000Z", value: 150 }], AT), null, "a price after the capture is not read");
  const readings = computeFundSignals({ funds: QUOTED_FUNDS, points: new Map([["XLK", [{ eventTime: TODAY, value: 100 }]]]), at: AT });
  assert.deepEqual(readings.get("XLK"), { signals: [], qualityGrade: "LOW", currentAt: TODAY });
});
