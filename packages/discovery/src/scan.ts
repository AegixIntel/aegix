/**
 * AEGIX Discovery Engine — proactive relationship scan, see
 * docs/milestone-d14-rewind-discovery.md.
 *
 * Nobody asks a question; the scan tests a fixed, versioned set of hypotheses
 * over the observation ledger and reports the relationships that are both new
 * and unlikely to be chance.
 *
 * Scanning many pairs is exactly how spurious relationships are manufactured,
 * so the controls are part of the engine rather than an afterthought:
 *
 *   1. The hypothesis set (series, transform, lags, windows) is fixed by
 *      DISCOVERY_ENGINE_VERSION. A run cannot add a lag because it looks good.
 *   2. Series are differenced to hourly log-changes before any correlation.
 *   3. p-values use an effective sample size corrected for autocorrelation.
 *   4. q-values are Benjamini–Yekutieli over every hypothesis the run tested,
 *      and that count is stored with the run.
 *   5. "New" is decided on a baseline window disjoint from the test window.
 *   6. A discovery is a CANDIDATE until a later, disjoint window reproduces
 *      it at the same lag and sign.
 *
 * A discovery is a statistical relationship between two series. It is not
 * causation, and says nothing about who is behind either series.
 */

import { createHash } from "node:crypto";
import { benjaminiYekutieli, correlationPValue, effectiveSampleSize, pearson } from "./stats.js";

export const DISCOVERY_ENGINE_VERSION = "discovery-v1.0.0";
export const DISCOVERY_METHOD = "pearson(hourly log-change) · Bartlett n_eff · Fisher z · Benjamini–Yekutieli";

/** Test window and the baseline window immediately before it. */
export const DISCOVERY_WINDOW_HOURS = 168;
export const DISCOVERY_BASELINE_HOURS = 168;
/** A run's epoch ends on a UTC day boundary; one run per epoch. */
export const DISCOVERY_EPOCH_HOURS = 24;
/** Positive lag: the first series leads the second by that many hours. */
export const DISCOVERY_LAGS_HOURS = [-24, -12, -6, -3, -2, -1, 0, 1, 2, 3, 6, 12, 24] as const;
/** Paired hourly changes required before a correlation is computed at all. */
export const DISCOVERY_MIN_PAIRS = 96;
/** False discovery rate each run is held to. */
export const DISCOVERY_FDR_LEVEL = 0.05;
/** A pair already correlated at or above this in the baseline is not new. */
export const DISCOVERY_BASELINE_MAX_ABS_R = 0.3;

const HOUR_MS = 3_600_000;

/**
 * One preregistered hypothesis set. Everything is in hours, and `stepHours`
 * is the resolution the series are differenced at: every window and lag is a
 * whole number of steps.
 */
export interface DiscoveryProfile {
  engineVersion: string;
  method: string;
  stepHours: number;
  windowHours: number;
  baselineHours: number;
  lagsHours: readonly number[];
  minPairs: number;
}

export const HOURLY_PROFILE: DiscoveryProfile = {
  engineVersion: DISCOVERY_ENGINE_VERSION,
  method: DISCOVERY_METHOD,
  stepHours: 1,
  windowHours: DISCOVERY_WINDOW_HOURS,
  baselineHours: DISCOVERY_BASELINE_HOURS,
  lagsHours: DISCOVERY_LAGS_HOURS,
  minPairs: DISCOVERY_MIN_PAIRS
};

/**
 * The daily scan. A series that only moves during a market session (listed
 * options, exchange-traded funds) never has 96 consecutive hours, so the
 * hourly scan cannot test it. Here each UTC day is one step: the day's last
 * observation, differenced against the day before. A day with no observation
 * is a gap, so a session series has no change across a weekend.
 *
 * Sixty days of test window after sixty of baseline: nothing can be tested
 * until a series has been captured for about four months.
 */
export const DAILY_PROFILE: DiscoveryProfile = {
  engineVersion: "discovery-daily-v1.0.0",
  method: "pearson(daily log-change) · Bartlett n_eff · Fisher z · Benjamini–Yekutieli",
  stepHours: 24,
  windowHours: 60 * 24,
  baselineHours: 60 * 24,
  lagsHours: [-120, -72, -48, -24, 0, 24, 48, 72, 120],
  minPairs: 30
};

export interface SeriesPoint { eventTime: string; value: number }
export interface SeriesInput { key: string; label: string; group: string; points: SeriesPoint[] }

export type Direction = "POSITIVE" | "NEGATIVE";

/** A discovery already on record, awaiting or undergoing confirmation. */
export interface OpenDiscovery { pairKey: string; lagHours: number; direction: Direction; windowEnd: string }

export type TestStatus = "TESTED" | "INSUFFICIENT_DATA" | "NO_VARIANCE" | "INSUFFICIENT_BASELINE" | "KNOWN_RELATIONSHIP" | "AWAITING_CONFIRMATION_WINDOW";

export interface TestRecord {
  pairKey: string;
  seriesA: string;
  seriesB: string;
  lagHours: number;
  status: TestStatus;
  role: "NOVELTY" | "CONFIRMATION" | null;
  r: number | null;
  rBaseline: number | null;
  n: number;
  nEffective: number | null;
  pValue: number | null;
  qValue: number | null;
  rejected: boolean;
}

export interface DiscoveryCard {
  title: string;
  summary: string;
  seriesA: { key: string; label: string; group: string };
  seriesB: { key: string; label: string; group: string };
  lagHours: number;
  direction: Direction;
  effect: { r: number; n: number; nEffective: number };
  pValue: number;
  qValue: number;
  /** 1 − q. The share of discoveries at this threshold expected to be real. */
  confidence: number;
  hypothesesTested: number;
  fdrLevel: number;
  method: string;
  window: { start: string; end: string };
  baseline: { start: string; end: string; maxAbsR: number };
  whyUnusual: string;
  whenItBegan: string;
  supporting: string[];
  contradicting: string[];
  historical: string;
  whatWouldConfirm: string;
  graph: { nodes: Array<{ id: string; label: string; group: string }>; edges: Array<{ from: string; to: string; r: number; lagHours: number }> };
  limitations: string[];
}

export interface NewDiscovery {
  pairKey: string;
  seriesA: string;
  seriesB: string;
  lagHours: number;
  direction: Direction;
  windowEnd: string;
  fingerprint: string;
  card: DiscoveryCard;
}

export interface ConfirmationOutcome {
  pairKey: string;
  eventType: "CONFIRMED" | "NOT_CONFIRMED";
  detail: { lagHours: number; r: number | null; n: number; pValue: number | null; qValue: number | null; windowStart: string; windowEnd: string; reason: string };
}

export interface ScanInput { series: SeriesInput[]; epochEnd: string; open: OpenDiscovery[] }

export interface ScanResult {
  engineVersion: string;
  epochEnd: string;
  seriesCount: number;
  hypothesesConsidered: number;
  hypothesesTested: number;
  rejections: number;
  tests: TestRecord[];
  discoveries: NewDiscovery[];
  confirmations: ConfirmationOutcome[];
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("~");
}

/** The epoch boundary at or before `now`: the last completed UTC day. */
export function epochEndFor(now: Date): Date {
  const step = DISCOVERY_EPOCH_HOURS * HOUR_MS;
  return new Date(Math.floor(now.getTime() / step) * step);
}

/** How far back a scan needs the ledger: both windows plus the longest lag. */
export function scanHorizonHours(profile: DiscoveryProfile = HOURLY_PROFILE): number {
  return profile.windowHours + profile.baselineHours + Math.max(...profile.lagsHours) + profile.stepHours;
}

export function discoveryFingerprint(key: string, lagHours: number, windowStart: string, windowEnd: string, engineVersion: string = DISCOVERY_ENGINE_VERSION): string {
  return createHash("sha256").update([engineVersion, key, lagHours, windowStart, windowEnd].join("|")).digest("hex");
}

/**
 * Log-changes per step, keyed by step index. A change exists only between two
 * consecutive steps that both have a positive value: a gap is left as a gap,
 * never interpolated. A step's value is its last observation.
 */
export function logChanges(points: SeriesPoint[], stepHours = 1): Map<number, number> {
  const stepMs = stepHours * HOUR_MS;
  const latest = new Map<number, { at: number; value: number }>();
  for (const p of points) {
    const at = Date.parse(p.eventTime);
    if (!Number.isFinite(at) || !Number.isFinite(p.value) || p.value <= 0) continue;
    const hour = Math.floor(at / stepMs);
    const existing = latest.get(hour);
    if (!existing || at >= existing.at) latest.set(hour, { at, value: p.value });
  }
  const changes = new Map<number, number>();
  for (const [hour, current] of latest) {
    const previous = latest.get(hour - 1);
    if (previous) changes.set(hour, Math.log(current.value / previous.value));
  }
  return changes;
}

export function hourlyLogChanges(points: SeriesPoint[]): Map<number, number> {
  return logChanges(points, 1);
}

function paired(a: Map<number, number>, b: Map<number, number>, lag: number, fromHour: number, toHour: number): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let hour = fromHour; hour < toHour; hour++) {
    const other = hour + lag;
    if (other < fromHour || other >= toHour) continue;
    const va = a.get(hour);
    const vb = b.get(other);
    if (va === undefined || vb === undefined) continue;
    x.push(va); y.push(vb);
  }
  return { x, y };
}

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

export function runScan(input: ScanInput, profile: DiscoveryProfile = HOURLY_PROFILE): ScanResult {
  const stepMs = profile.stepHours * HOUR_MS;
  const daily = profile.stepHours === 24;
  const epochEndMs = Date.parse(input.epochEnd);
  if (!Number.isFinite(epochEndMs) || epochEndMs % stepMs !== 0) throw new Error(daily ? "epochEnd must be a whole UTC day" : "epochEnd must be a whole UTC hour");
  // Steps, not hours, from here on. At the hourly resolution they are the
  // same, which is why the names below still say hour.
  const lags = profile.lagsHours.map((lag) => lag / profile.stepHours);
  const toHour = epochEndMs / stepMs;
  const fromHour = toHour - profile.windowHours / profile.stepHours;
  const baseFromHour = fromHour - profile.baselineHours / profile.stepHours;
  const iso = (hour: number) => new Date(hour * stepMs).toISOString();
  const span = (steps: number) => (daily ? `${steps}d` : `${steps}h`);
  const lagText = (lagHours: number, a: string, b: string) => {
    const lag = lagHours / profile.stepHours;
    return lag === 0 ? (daily ? "same day" : "same hour") : lag > 0 ? `${a} leading ${b} by ${span(lag)}` : `${b} leading ${a} by ${span(-lag)}`;
  };

  // Nothing at or after the epoch end is read, whatever the caller loaded.
  const series = [...input.series].sort((a, b) => a.key.localeCompare(b.key));
  const changes = new Map(series.map((s) => [s.key, logChanges(s.points.filter((p) => Date.parse(p.eventTime) < epochEndMs), profile.stepHours)]));
  const openByPair = new Map(input.open.map((o) => [o.pairKey, o]));

  const tests: TestRecord[] = [];
  const blank = { r: null, rBaseline: null, n: 0, nEffective: null, pValue: null, qValue: null, rejected: false } as const;
  const baselineMax = new Map<string, number>();

  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const a = series[i]!;
      const b = series[j]!;
      const key = pairKey(a.key, b.key);
      const ca = changes.get(a.key)!;
      const cb = changes.get(b.key)!;
      const base = { pairKey: key, seriesA: a.key, seriesB: b.key };

      const evaluate = (lagSteps: number, role: "NOVELTY" | "CONFIRMATION", rBaseline: number | null): TestRecord => {
        const lag = lagSteps * profile.stepHours;
        const { x, y } = paired(ca, cb, lagSteps, fromHour, toHour);
        if (x.length < profile.minPairs) return { ...base, ...blank, lagHours: lag, status: "INSUFFICIENT_DATA", role: null, n: x.length, rBaseline };
        const r = pearson(x, y);
        // A series that did not move has no correlation to test. That is a
        // fact about the window, distinct from not having enough of it.
        if (r === null) return { ...base, ...blank, lagHours: lag, status: "NO_VARIANCE", role: null, n: x.length, rBaseline };
        const nEffective = effectiveSampleSize(x, y);
        return { ...base, lagHours: lag, status: "TESTED", role, r, rBaseline, n: x.length, nEffective,
          pValue: correlationPValue(r, nEffective), qValue: null, rejected: false };
      };

      const open = openByPair.get(key);
      if (open) {
        // Confirmation is preregistered: the original lag only, and only once
        // the test window no longer overlaps the window it was found in.
        if (fromHour * stepMs < Date.parse(open.windowEnd)) {
          tests.push({ ...base, ...blank, lagHours: open.lagHours, status: "AWAITING_CONFIRMATION_WINDOW", role: null });
        } else {
          tests.push(evaluate(open.lagHours / profile.stepHours, "CONFIRMATION", null));
        }
        continue;
      }

      const baseline = new Map<number, number>();
      for (const lag of lags) {
        const { x, y } = paired(ca, cb, lag, baseFromHour, fromHour);
        const r = x.length >= profile.minPairs ? pearson(x, y) : null;
        if (r !== null) baseline.set(lag, r);
      }
      const maxAbs = baseline.size > 0 ? Math.max(...[...baseline.values()].map(Math.abs)) : null;
      if (maxAbs !== null) baselineMax.set(key, maxAbs);

      for (const lag of lags) {
        const rBaseline = baseline.get(lag) ?? null;
        const lagHours = lag * profile.stepHours;
        if (rBaseline === null) tests.push({ ...base, ...blank, lagHours, status: "INSUFFICIENT_BASELINE", role: null });
        else if (maxAbs! >= DISCOVERY_BASELINE_MAX_ABS_R) tests.push({ ...base, ...blank, lagHours, status: "KNOWN_RELATIONSHIP", role: null, rBaseline });
        else tests.push(evaluate(lag, "NOVELTY", rBaseline));
      }
    }
  }

  const tested = tests.filter((t) => t.status === "TESTED");
  const qValues = benjaminiYekutieli(tested.map((t) => t.pValue!));
  tested.forEach((t, index) => {
    t.qValue = qValues[index]!;
    t.rejected = t.qValue <= DISCOVERY_FDR_LEVEL;
  });

  const byKey = new Map(series.map((s) => [s.key, s]));
  const windowStart = iso(fromHour);
  const windowEnd = iso(toHour);
  const discoveries: NewDiscovery[] = [];
  const confirmations: ConfirmationOutcome[] = [];

  const novelty = new Map<string, TestRecord[]>();
  for (const t of tested) {
    if (t.role === "NOVELTY") novelty.set(t.pairKey, [...(novelty.get(t.pairKey) ?? []), t]);
    if (t.role !== "CONFIRMATION") continue;
    const open = openByPair.get(t.pairKey)!;
    const sameSign = (t.r! >= 0 ? "POSITIVE" : "NEGATIVE") === open.direction;
    const confirmed = t.rejected && sameSign;
    confirmations.push({ pairKey: t.pairKey, eventType: confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
      detail: { lagHours: t.lagHours, r: round(t.r!), n: t.n, pValue: t.pValue, qValue: t.qValue, windowStart, windowEnd,
        reason: confirmed ? "Reproduced at the original lag and sign in a window disjoint from the detection window."
          : !sameSign ? "The relationship changed sign in the confirmation window."
          : "Not significant after correction in the confirmation window." } });
  }

  for (const [key, group] of novelty) {
    const rejected = group.filter((t) => t.rejected);
    if (rejected.length === 0) continue;
    const best = [...rejected].sort((x, y) => x.qValue! - y.qValue! || Math.abs(y.r!) - Math.abs(x.r!) || Math.abs(x.lagHours) - Math.abs(y.lagHours))[0]!;
    const a = byKey.get(best.seriesA)!;
    const b = byKey.get(best.seriesB)!;
    const direction: Direction = best.r! >= 0 ? "POSITIVE" : "NEGATIVE";
    const maxAbs = baselineMax.get(key)!;
    const days = profile.windowHours / 24;
    const confirmAt = iso(toHour + profile.windowHours / profile.stepHours);
    const card: DiscoveryCard = {
      title: `${a.label} and ${b.label} have developed an unusual relationship`,
      summary: `${daily ? "Daily" : "Hourly"} changes in ${a.label} and ${b.label} moved ${direction === "POSITIVE" ? "together" : "in opposite directions"} over the ${days} days to ${windowEnd} (r = ${round(best.r!, 3)}, ${lagText(best.lagHours, a.label, b.label)}).`,
      seriesA: { key: a.key, label: a.label, group: a.group },
      seriesB: { key: b.key, label: b.label, group: b.group },
      lagHours: best.lagHours,
      direction,
      effect: { r: round(best.r!), n: best.n, nEffective: round(best.nEffective!, 1) },
      pValue: best.pValue!,
      qValue: best.qValue!,
      confidence: round(1 - best.qValue!),
      hypothesesTested: tested.length,
      fdrLevel: DISCOVERY_FDR_LEVEL,
      method: profile.method,
      window: { start: windowStart, end: windowEnd },
      baseline: { start: iso(baseFromHour), end: windowStart, maxAbsR: round(maxAbs) },
      whyUnusual: `In the ${profile.baselineHours / 24} days before this window the strongest correlation between these series at any tested lag was |r| = ${round(maxAbs, 3)}, below the ${DISCOVERY_BASELINE_MAX_ABS_R} threshold for an existing relationship. In this window it is ${round(Math.abs(best.r!), 3)}, and it survives correction across ${tested.length} hypotheses.`,
      whenItBegan: `It is first measurable in the window ${windowStart} to ${windowEnd}. The engine tests whole windows, so it cannot place the start more precisely than that.`,
      supporting: rejected.map((t) => `${lagText(t.lagHours, a.label, b.label)}: r = ${round(t.r!, 3)}, q = ${t.qValue!.toExponential(2)}, n = ${t.n} (effective ${round(t.nEffective!, 1)})`),
      contradicting: [
        ...group.filter((t) => !t.rejected).map((t) => `${lagText(t.lagHours, a.label, b.label)}: r = ${round(t.r!, 3)}, not significant after correction (q = ${t.qValue!.toFixed(3)})`),
        `Baseline window: strongest |r| = ${round(maxAbs, 3)} — the relationship was absent then.`
      ],
      historical: `Not observed in the baseline window ${iso(baseFromHour)} to ${windowStart}. The ledger holds no earlier test of this pair by this engine version, so nothing is claimed about older history.`,
      whatWouldConfirm: `The same sign at the same lag, significant after correction, in a window that does not overlap this one. The first such window ends ${confirmAt}. Until then this is a CANDIDATE.`,
      graph: {
        nodes: [{ id: a.key, label: a.label, group: a.group }, { id: b.key, label: b.label, group: b.group }],
        edges: rejected.map((t) => t.lagHours >= 0
          ? { from: a.key, to: b.key, r: round(t.r!), lagHours: t.lagHours }
          : { from: b.key, to: a.key, r: round(t.r!), lagHours: -t.lagHours })
      },
      limitations: [
        "A statistical relationship between two series. It does not establish causation, and identifies no participant, owner or intent.",
        `The false discovery rate is controlled at ${DISCOVERY_FDR_LEVEL} within this run, across ${tested.length} hypotheses. Runs repeat daily over overlapping windows, so the rate over many runs is higher than within one; confirmation in a disjoint window is what addresses that.`,
        daily
          ? "Series are differenced to daily log-changes of each UTC day's last observation. A day with no observation is skipped, not interpolated, so a series that trades in sessions has no change across a weekend or holiday."
          : "Series are differenced to hourly log-changes; hours with a missing observation are skipped, not interpolated.",
        "Rolling 24h volume is an overlapping total, which the effective sample size corrects for only approximately."
      ]
    };
    discoveries.push({ pairKey: key, seriesA: a.key, seriesB: b.key, lagHours: best.lagHours, direction, windowEnd,
      fingerprint: discoveryFingerprint(key, best.lagHours, windowStart, windowEnd, profile.engineVersion), card });
  }

  return {
    engineVersion: profile.engineVersion,
    epochEnd: windowEnd,
    seriesCount: series.length,
    hypothesesConsidered: tests.length,
    hypothesesTested: tested.length,
    rejections: tested.filter((t) => t.rejected).length,
    tests,
    discoveries: discoveries.sort((x, y) => x.pairKey.localeCompare(y.pairKey)),
    confirmations: confirmations.sort((x, y) => x.pairKey.localeCompare(y.pairKey))
  };
}
