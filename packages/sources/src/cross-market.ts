/**
 * Cross-Market Intelligence: how the market classes AEGIX captures stand
 * against each other now. See
 * docs/milestone-d15-market-intelligence-engines.md §4.
 *
 * Everything is measured on the observation ledger: returns over a day and a
 * week per series, how many members of a class rose, how the classes' hourly
 * moves correlated over the week, and where each sector fund's day sits
 * among the others.
 *
 * These are descriptions of prices already on record. A correlation between
 * two classes over one week is not a relationship that will hold next week,
 * and a class is only the members AEGIX captures, not the market it is named
 * after.
 */

import { hourlyChanges, median, type SourcedPoint } from "./anomaly.js";
import { fundDayReturn } from "./context-signals.js";

export const CROSS_MARKET_ENGINE_VERSION = "cross-market-v1.0.0";

const HOUR_MS = 3_600_000;

/** Hours of hourly changes the class correlations are measured over. */
export const CROSS_MARKET_CORRELATION_HOURS = 168;
/** Paired hours two classes must share before a correlation is reported. */
export const CROSS_MARKET_MIN_PAIRS = 96;
/** A price this old is not "now", and a reference price this far from its mark is not that mark. */
export const CROSS_MARKET_STALE_HOURS = 3;
/** Median day returns of two classes this far apart, with opposite signs, are called a divergence. */
export const CROSS_MARKET_DIVERGENCE_PERCENT = 1;
/** Share of hourly-priced members up or down on the day at which the move is called broad. */
export const CROSS_MARKET_BREADTH_SHARE = 0.8;
/** Members with a day return before breadth means anything. */
export const CROSS_MARKET_MIN_BREADTH_MEMBERS = 8;

/** Classes priced every hour of the week, and classes priced only in the US session. */
export type CrossMarketClass = "CRYPTO" | "TOKENIZED_EQUITY" | "TOKENIZED_GOLD" | "SECTOR_FUND" | "COMMODITY_FUND";

export interface CrossMarketSeries {
  key: string;
  symbol: string;
  label: string;
  marketClass: CrossMarketClass;
  /** Session series trade about 6.5 hours a day: day return only, no hourly correlation. */
  session: boolean;
  points: readonly SourcedPoint[];
}

export interface CrossMarketMember {
  symbol: string;
  label: string;
  price: number | null;
  priceAt: string | null;
  return24hPercent: number | null;
  return7dPercent: number | null;
}

export interface CrossMarketClassReading {
  marketClass: CrossMarketClass;
  session: boolean;
  members: CrossMarketMember[];
  /** Members that have a day return. */
  measured: number;
  advancing: number;
  median24hPercent: number | null;
  median7dPercent: number | null;
}

export interface CrossMarketCorrelation {
  a: CrossMarketClass;
  b: CrossMarketClass;
  /** Pearson r of the two classes' mean hourly log-changes; null when too few hours are shared. */
  r: number | null;
  pairedHours: number;
}

export interface CrossMarketReading {
  type: "CLASS_DIVERGENCE" | "BROAD_ADVANCE" | "BROAD_DECLINE";
  title: string;
  summary: string;
}

export interface CrossMarketView {
  engineVersion: string;
  asOf: string;
  classes: CrossMarketClassReading[];
  correlations: CrossMarketCorrelation[];
  /** Sector funds by their move on the day, strongest first, each against the median sector fund. */
  sectors: Array<{ symbol: string; label: string; dayReturnPercent: number; excessPoints: number }>;
  readings: CrossMarketReading[];
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** The newest price, and the returns to it from a day and a week before, all from one source. */
function hourlyMember(series: CrossMarketSeries, at: Date): CrossMarketMember {
  const now = at.getTime();
  const all = series.points.map((p) => ({ time: Date.parse(p.eventTime), value: p.value, source: p.source ?? "" }))
    .filter((p) => Number.isFinite(p.time) && p.time <= now && p.value > 0).sort((a, b) => a.time - b.time);
  const latest = all.at(-1);
  const member: CrossMarketMember = { symbol: series.symbol, label: series.label, price: null, priceAt: null, return24hPercent: null, return7dPercent: null };
  if (!latest || now - latest.time > CROSS_MARKET_STALE_HOURS * HOUR_MS) return member;
  member.price = latest.value;
  member.priceAt = new Date(latest.time).toISOString();
  const same = all.filter((p) => p.source === latest.source);
  const before = (hours: number) => {
    const mark = now - hours * HOUR_MS;
    const reference = same.filter((p) => p.time <= mark).at(-1);
    return reference && mark - reference.time <= CROSS_MARKET_STALE_HOURS * HOUR_MS ? round((latest.value / reference.value - 1) * 100) : null;
  };
  member.return24hPercent = before(24);
  member.return7dPercent = before(168);
  return member;
}

/** A fund's last price today against the previous session's last price. */
function sessionMember(series: CrossMarketSeries, at: Date): CrossMarketMember {
  const day = fundDayReturn(series.points, at);
  return {
    symbol: series.symbol, label: series.label, price: day ? day.current : null, priceAt: day ? day.currentAt : null,
    return24hPercent: day ? round(day.percent) : null, return7dPercent: null
  };
}

/** Mean hourly log-change of a class, for the hours at least half of its members have one. */
function classChanges(members: readonly CrossMarketSeries[], fromHour: number, toHour: number): Map<number, number> {
  const perMember = members.map((m) => hourlyChanges(m.points));
  const result = new Map<number, number>();
  for (let hour = fromHour; hour < toHour; hour++) {
    const values = perMember.map((changes) => changes.get(hour)?.change).filter((v): v is number => v !== undefined);
    if (values.length > 0 && values.length * 2 >= members.length) result.set(hour, values.reduce((sum, v) => sum + v, 0) / values.length);
  }
  return result;
}

function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i]! - mx; const dy = y[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy))) : null;
}

const CLASS_ORDER: readonly CrossMarketClass[] = ["CRYPTO", "TOKENIZED_EQUITY", "TOKENIZED_GOLD", "SECTOR_FUND", "COMMODITY_FUND"];
const CLASS_NAME: Record<CrossMarketClass, string> = {
  CRYPTO: "crypto assets", TOKENIZED_EQUITY: "tokenized equities", TOKENIZED_GOLD: "tokenized gold", SECTOR_FUND: "sector funds", COMMODITY_FUND: "commodity funds"
};

export function buildCrossMarketView(input: { series: readonly CrossMarketSeries[]; at: Date }): CrossMarketView {
  const { at } = input;
  const classes: CrossMarketClassReading[] = [];
  for (const marketClass of CLASS_ORDER) {
    const own = input.series.filter((s) => s.marketClass === marketClass);
    if (own.length === 0) continue;
    const session = own.every((s) => s.session);
    const members = own.map((s) => s.session ? sessionMember(s, at) : hourlyMember(s, at));
    const day = members.map((m) => m.return24hPercent).filter((v): v is number => v !== null);
    const week = members.map((m) => m.return7dPercent).filter((v): v is number => v !== null);
    classes.push({
      marketClass, session, members, measured: day.length, advancing: day.filter((v) => v > 0).length,
      median24hPercent: day.length ? round(median(day)) : null, median7dPercent: week.length ? round(median(week)) : null
    });
  }

  // Correlations are between classes priced around the clock: a session class
  // has no change in most hours, and its gaps would decide the answer.
  const currentHour = Math.floor(at.getTime() / HOUR_MS);
  const hourly = CLASS_ORDER.map((marketClass) => ({ marketClass, members: input.series.filter((s) => s.marketClass === marketClass && !s.session) }))
    .filter((c) => c.members.length > 0)
    .map((c) => ({ marketClass: c.marketClass, changes: classChanges(c.members, currentHour - CROSS_MARKET_CORRELATION_HOURS, currentHour) }));
  const correlations: CrossMarketCorrelation[] = [];
  for (let i = 0; i < hourly.length; i++) {
    for (let j = i + 1; j < hourly.length; j++) {
      const x: number[] = [];
      const y: number[] = [];
      for (const [hour, value] of hourly[i]!.changes) { const other = hourly[j]!.changes.get(hour); if (other !== undefined) { x.push(value); y.push(other); } }
      const r = x.length >= CROSS_MARKET_MIN_PAIRS ? pearson(x, y) : null;
      correlations.push({ a: hourly[i]!.marketClass, b: hourly[j]!.marketClass, r: r === null ? null : round(r, 3), pairedHours: x.length });
    }
  }

  const sectorFunds = input.series.filter((s) => s.marketClass === "SECTOR_FUND")
    .map((s) => ({ series: s, day: fundDayReturn(s.points, at) })).filter((s): s is { series: CrossMarketSeries; day: NonNullable<ReturnType<typeof fundDayReturn>> } => s.day !== null);
  const sectorMedian = sectorFunds.length ? median(sectorFunds.map((s) => s.day.percent)) : 0;
  const sectors = sectorFunds
    .map((s) => ({ symbol: s.series.symbol, label: s.series.label, dayReturnPercent: round(s.day.percent), excessPoints: round(s.day.percent - sectorMedian) }))
    .sort((a, b) => b.dayReturnPercent - a.dayReturnPercent || a.symbol.localeCompare(b.symbol));

  const readings: CrossMarketReading[] = [];
  const measuredClasses = classes.filter((c) => c.median24hPercent !== null);
  for (let i = 0; i < measuredClasses.length; i++) {
    for (let j = i + 1; j < measuredClasses.length; j++) {
      const a = measuredClasses[i]!;
      const b = measuredClasses[j]!;
      const ma = a.median24hPercent!;
      const mb = b.median24hPercent!;
      if (ma * mb < 0 && Math.abs(ma) >= CROSS_MARKET_DIVERGENCE_PERCENT && Math.abs(mb) >= CROSS_MARKET_DIVERGENCE_PERCENT) {
        readings.push({
          type: "CLASS_DIVERGENCE",
          title: `${CLASS_NAME[a.marketClass]} and ${CLASS_NAME[b.marketClass]} moved apart on the day`,
          summary: `The median of the ${a.measured} ${CLASS_NAME[a.marketClass]} measured is ${ma}% on the day; the median of the ${b.measured} ${CLASS_NAME[b.marketClass]} is ${mb}%.`
        });
      }
    }
  }
  const around = classes.filter((c) => !c.session);
  const measured = around.reduce((sum, c) => sum + c.measured, 0);
  const advancing = around.reduce((sum, c) => sum + c.advancing, 0);
  if (measured >= CROSS_MARKET_MIN_BREADTH_MEMBERS) {
    const share = advancing / measured;
    if (share >= CROSS_MARKET_BREADTH_SHARE || share <= 1 - CROSS_MARKET_BREADTH_SHARE) {
      const up = share >= CROSS_MARKET_BREADTH_SHARE;
      readings.push({
        type: up ? "BROAD_ADVANCE" : "BROAD_DECLINE",
        title: `Most of what is priced around the clock is ${up ? "up" : "down"} on the day`,
        summary: `${up ? advancing : measured - advancing} of the ${measured} crypto assets and tokenized stocks with a price a day ago are ${up ? "above" : "at or below"} it.`
      });
    }
  }

  return { engineVersion: CROSS_MARKET_ENGINE_VERSION, asOf: at.toISOString(), classes, correlations, sectors, readings };
}

/** Hours of ledger a view reads: the correlation week, the week-ago price and its tolerance. */
export const CROSS_MARKET_HORIZON_HOURS = 168 + CROSS_MARKET_STALE_HOURS + 2;
