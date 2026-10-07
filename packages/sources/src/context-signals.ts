/**
 * Context signals: what the news and the sector funds were doing, stored at
 * capture time so Rewind can replay it. See
 * docs/milestone-d14-rewind-discovery.md §3a.
 *
 * Like the market signals, every one is a measurement with a stated
 * threshold, computed once from the ledger as it stood, and never again. The
 * thresholds are part of CONTEXT_ENGINE_VERSION: changing one is a new
 * version, and captures stored under the old one keep saying what they said.
 *
 * None is a prediction or advice. A topic that is written about more is not
 * a topic that matters more, and a fund that moved is not a reason it moved.
 */

import type { QuotedFund } from "./sector-quotes.js";
import type { NarrativeTopic } from "./narrative.js";
import { usEasternClock } from "./us-session.js";

export const CONTEXT_ENGINE_VERSION = "context-v1.0.0";

const HOUR_MS = 3_600_000;

export interface ContextSignal {
  type: "NARRATIVE_ACCELERATION" | "SECTOR_RELATIVE_STRENGTH" | "SECTOR_RELATIVE_WEAKNESS" | "FUND_DAILY_MOVE";
  severity: number;
  confidence: number;
  title: string;
  summary: string;
  evidence: Array<{ key: string; value: string | number | boolean; label: string }>;
  engineVersion: string;
}

export interface ContextReading {
  signals: ContextSignal[];
  /** How much of the input the reading had: LOW means nothing could be measured. */
  qualityGrade: "HIGH" | "MEDIUM" | "LOW";
}

export interface LedgerPoint { eventTime: string; value: number }

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

function signal(type: ContextSignal["type"], severity: number, confidence: number, title: string, summary: string, evidence: ContextSignal["evidence"]): ContextSignal {
  return { type, severity: clamp(Math.round(severity), 0, 100), confidence: round(clamp(confidence, 0, 1), 3), title, summary, evidence, engineVersion: CONTEXT_ENGINE_VERSION };
}

// ---------------------------------------------------------------------------
// Narrative: articles mentioning a topic, per hour, from GDELT Context.
// ---------------------------------------------------------------------------

/** The hours compared: the newest six settled hours against the forty-eight before them. */
export const NARRATIVE_RECENT_HOURS = 6;
export const NARRATIVE_BASELINE_HOURS = 48;
/** Hours that must hold a count before anything is measured. */
export const NARRATIVE_MIN_RECENT_HOURS = 4;
export const NARRATIVE_MIN_BASELINE_HOURS = 24;
/** Recent mean over baseline mean at or above which coverage is called accelerating. */
export const NARRATIVE_ACCELERATION_RATIO = 2;
/** Below this many articles an hour, a doubling is two articles instead of one. */
export const NARRATIVE_MIN_MENTIONS = 3;
/** An hour is read once it has been over for an hour, as the source reads it. */
export const NARRATIVE_SETTLE_HOURS = 1;

/** The counts held for the newest settled hours and for the baseline hours before them. */
export function narrativeWindows(points: readonly LedgerPoint[], at: Date): { recent: number[]; baseline: number[]; newestHour: number } {
  const newest = Math.floor(at.getTime() / HOUR_MS) - 1 - NARRATIVE_SETTLE_HOURS;
  const byHour = new Map<number, number>();
  for (const point of points) {
    const time = Date.parse(point.eventTime);
    if (Number.isFinite(time) && Number.isFinite(point.value) && point.value >= 0) byHour.set(Math.floor(time / HOUR_MS), point.value);
  }
  const collect = (from: number, to: number) => {
    const values: number[] = [];
    for (let hour = from; hour <= to; hour++) { const value = byHour.get(hour); if (value !== undefined) values.push(value); }
    return values;
  };
  return {
    recent: collect(newest - NARRATIVE_RECENT_HOURS + 1, newest),
    baseline: collect(newest - NARRATIVE_RECENT_HOURS - NARRATIVE_BASELINE_HOURS + 1, newest - NARRATIVE_RECENT_HOURS),
    newestHour: newest
  };
}

/**
 * Whether a topic is being written about faster than in the two days before.
 *
 * Only hours the ledger holds are averaged. An hour with no row was either
 * not read or held no article, and the ledger cannot say which, so it is left
 * out of both means rather than counted as zero.
 */
export function computeNarrativeSignals(input: { topic: NarrativeTopic; points: readonly LedgerPoint[]; at: Date }): ContextReading {
  const { recent, baseline } = narrativeWindows(input.points, input.at);
  if (recent.length < NARRATIVE_MIN_RECENT_HOURS || baseline.length < NARRATIVE_MIN_BASELINE_HOURS) return { signals: [], qualityGrade: "LOW" };

  const qualityGrade = recent.length === NARRATIVE_RECENT_HOURS && baseline.length >= 40 ? "HIGH" : "MEDIUM";
  const recentMean = mean(recent);
  const baselineMean = mean(baseline);
  if (baselineMean <= 0 || recentMean < NARRATIVE_MIN_MENTIONS) return { signals: [], qualityGrade };
  const ratio = recentMean / baselineMean;
  if (ratio < NARRATIVE_ACCELERATION_RATIO) return { signals: [], qualityGrade };

  return { qualityGrade, signals: [signal(
    "NARRATIVE_ACCELERATION",
    25 * ratio,
    (recent.length / NARRATIVE_RECENT_HOURS) * (baseline.length / NARRATIVE_BASELINE_HOURS),
    `${input.topic.label} coverage accelerating`,
    `Articles mentioning ${input.topic.label} averaged ${round(recentMean, 1)} an hour over the last ${NARRATIVE_RECENT_HOURS} read hours, ${round(ratio, 1)} times the ${round(baselineMean, 1)} an hour of the ${NARRATIVE_BASELINE_HOURS} hours before.`,
    [
      { key: "recent_mean", value: round(recentMean), label: "Articles per hour, recent" },
      { key: "baseline_mean", value: round(baselineMean), label: "Articles per hour, baseline" },
      { key: "ratio", value: round(ratio), label: "Recent over baseline" },
      { key: "recent_hours", value: recent.length, label: `Recent hours held, of ${NARRATIVE_RECENT_HOURS}` },
      { key: "baseline_hours", value: baseline.length, label: `Baseline hours held, of ${NARRATIVE_BASELINE_HOURS}` }
    ]
  )] };
}

// ---------------------------------------------------------------------------
// Funds: the day's move of each sector and commodity fund.
// ---------------------------------------------------------------------------

/** A sector fund this far from the median sector fund's day, in percentage points. */
export const SECTOR_EXCESS_PERCENT = 1.5;
/** Any fund's own move on the day, in percent. */
export const FUND_DAILY_MOVE_PERCENT = 2.5;
/** Sector funds with a return today before the median means anything. */
export const SECTOR_MIN_FUNDS = 8;
/** The previous session may be this many days back: a long weekend, not a missing week. */
export const FUND_MAX_PREVIOUS_DAYS = 5;

export const isSectorFund = (fund: QuotedFund) => fund.group.startsWith("sector:");

/** Today's last price over the previous session's last price, in percent; null without both. */
export function fundDayReturn(points: readonly LedgerPoint[], at: Date): { percent: number; current: number; previous: number; currentAt: string } | null {
  const today = usEasternClock(at).date;
  let current: { time: number; value: number } | null = null;
  let previous: { time: number; value: number } | null = null;
  for (const point of points) {
    const time = Date.parse(point.eventTime);
    if (!Number.isFinite(time) || time > at.getTime() || !(point.value > 0)) continue;
    const day = usEasternClock(new Date(time)).date;
    if (day === today) { if (!current || time >= current.time) current = { time, value: point.value }; }
    else if (day < today && (!previous || time >= previous.time)) previous = { time, value: point.value };
  }
  if (!current || !previous) return null;
  if (current.time - previous.time > FUND_MAX_PREVIOUS_DAYS * 24 * HOUR_MS) return null;
  return { percent: (current.value / previous.value - 1) * 100, current: current.value, previous: previous.value, currentAt: new Date(current.time).toISOString() };
}

/**
 * One reading per fund that has a price today. A fund with none is absent
 * from the result: nobody looked at it in this session.
 */
export function computeFundSignals(input: { funds: readonly QuotedFund[]; points: ReadonlyMap<string, readonly LedgerPoint[]>; at: Date }): Map<string, ContextReading & { currentAt: string }> {
  const today = usEasternClock(input.at).date;
  const returns = new Map<string, NonNullable<ReturnType<typeof fundDayReturn>>>();
  const seenToday = new Map<string, string>();
  for (const fund of input.funds) {
    const points = input.points.get(fund.symbol) ?? [];
    const result = fundDayReturn(points, input.at);
    if (result) returns.set(fund.symbol, result);
    const latest = points.filter((p) => Date.parse(p.eventTime) <= input.at.getTime() && usEasternClock(new Date(p.eventTime)).date === today).at(-1);
    if (latest) seenToday.set(fund.symbol, latest.eventTime);
  }
  const sectorReturns = input.funds.filter(isSectorFund).map((f) => returns.get(f.symbol)?.percent).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const median = sectorReturns.length >= SECTOR_MIN_FUNDS
    ? (sectorReturns.length % 2 ? sectorReturns[(sectorReturns.length - 1) / 2]! : (sectorReturns[sectorReturns.length / 2 - 1]! + sectorReturns[sectorReturns.length / 2]!) / 2)
    : null;

  const readings = new Map<string, ContextReading & { currentAt: string }>();
  for (const fund of input.funds) {
    const currentAt = seenToday.get(fund.symbol);
    if (!currentAt) continue;
    const day = returns.get(fund.symbol);
    if (!day) { readings.set(fund.symbol, { signals: [], qualityGrade: "LOW", currentAt }); continue; }
    const signals: ContextSignal[] = [];
    const sector = isSectorFund(fund);
    if (sector && median !== null) {
      const excess = day.percent - median;
      if (Math.abs(excess) >= SECTOR_EXCESS_PERCENT) {
        signals.push(signal(
          excess > 0 ? "SECTOR_RELATIVE_STRENGTH" : "SECTOR_RELATIVE_WEAKNESS",
          30 * Math.abs(excess),
          sectorReturns.length / input.funds.filter(isSectorFund).length,
          `${fund.symbol} ${excess > 0 ? "ahead of" : "behind"} the other sector funds`,
          `${fund.symbol} (${fund.holds}) is ${round(day.percent)}% on the day against a median of ${round(median)}% across ${sectorReturns.length} sector funds, ${round(Math.abs(excess))} points ${excess > 0 ? "ahead" : "behind"}.`,
          [
            { key: "day_return_percent", value: round(day.percent), label: "Fund's move on the day, %" },
            { key: "sector_median_percent", value: round(median), label: "Median sector fund's move, %" },
            { key: "excess_points", value: round(excess), label: "Difference, percentage points" },
            { key: "sector_funds", value: sectorReturns.length, label: "Sector funds with a return today" }
          ]
        ));
      }
    }
    if (Math.abs(day.percent) >= FUND_DAILY_MOVE_PERCENT) {
      signals.push(signal(
        "FUND_DAILY_MOVE",
        20 * Math.abs(day.percent),
        1,
        `${fund.symbol} moved ${round(Math.abs(day.percent), 1)}% on the day`,
        `${fund.symbol} (${fund.holds}) last traded at ${round(day.current)}, ${round(day.percent)}% from the previous session's last read price of ${round(day.previous)}.`,
        [
          { key: "day_return_percent", value: round(day.percent), label: "Fund's move on the day, %" },
          { key: "price", value: round(day.current), label: "Last read price, USD" },
          { key: "previous_price", value: round(day.previous), label: "Previous session's last read price, USD" }
        ]
      ));
    }
    readings.set(fund.symbol, { signals, qualityGrade: sector && median === null ? "MEDIUM" : "HIGH", currentAt });
  }
  return readings;
}
