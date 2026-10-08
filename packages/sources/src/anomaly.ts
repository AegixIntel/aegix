/**
 * Anomaly Detection: whether a series' newest hourly change is far outside
 * what that same series did in the two weeks before. See
 * docs/milestone-d15-market-intelligence-engines.md §2.
 *
 * The baseline is the observation ledger, which is the historical store this
 * product waited for. A reading is made once, at capture time, from the
 * ledger as it stood, and stored; the thresholds are part of
 * ANOMALY_ENGINE_VERSION and a stored capture keeps saying what it said.
 *
 * An anomaly is a large move measured against the series' own recent moves.
 * It is not a cause, a forecast or advice, and a series that moves a lot
 * every day needs a larger move to be called one.
 */

import type { LedgerPoint } from "./context-signals.js";

export const ANOMALY_ENGINE_VERSION = "anomaly-v1.0.0";

const HOUR_MS = 3_600_000;

/** Hours of the series' own history the newest change is measured against. */
export const ANOMALY_BASELINE_HOURS = 336;
/** Hourly changes the baseline must hold before anything is measured. */
export const ANOMALY_MIN_BASELINE_CHANGES = 96;
/** Modified z-score at or above which a change is called an anomaly (Iglewicz and Hoaglin). */
export const ANOMALY_Z_THRESHOLD = 3.5;
/** A change older than this is not captured: it was not seen as it happened. */
export const ANOMALY_MAX_AGE_HOURS = 6;
/** Scales the median absolute deviation to a standard deviation under normality. */
const MAD_SCALE = 0.6745;

export interface AnomalySignal {
  type: "SERIES_ANOMALY_UP" | "SERIES_ANOMALY_DOWN";
  severity: number;
  confidence: number;
  title: string;
  summary: string;
  evidence: Array<{ key: string; value: string | number | boolean; label: string }>;
  engineVersion: string;
}

export interface AnomalyReading {
  signals: AnomalySignal[];
  /** LOW means the baseline was too short or flat and nothing was measured. */
  qualityGrade: "HIGH" | "MEDIUM" | "LOW";
  /** Start of the hour the measured change ends in; null when the series has no recent change. */
  changeHour: string | null;
  /** Source of the two readings the change was taken between. */
  source: string | null;
}

export interface SourcedPoint extends LedgerPoint { source?: string }

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Log-changes per hour, keyed by hour index. An hour's value is its last
 * observation. A change exists only between two consecutive hours that both
 * hold a positive value from the same source: a gap stays a gap, and two
 * providers' levels are never differenced against each other.
 */
export function hourlyChanges(points: readonly SourcedPoint[]): Map<number, { change: number; source: string }> {
  const latest = new Map<number, { at: number; value: number; source: string }>();
  for (const point of points) {
    const at = Date.parse(point.eventTime);
    if (!Number.isFinite(at) || !Number.isFinite(point.value) || point.value <= 0) continue;
    const hour = Math.floor(at / HOUR_MS);
    const existing = latest.get(hour);
    if (!existing || at >= existing.at) latest.set(hour, { at, value: point.value, source: point.source ?? "" });
  }
  const changes = new Map<number, { change: number; source: string }>();
  for (const [hour, current] of latest) {
    const previous = latest.get(hour - 1);
    if (previous && previous.source === current.source) changes.set(hour, { change: Math.log(current.value / previous.value), source: current.source });
  }
  return changes;
}

/**
 * Reads the newest completed hourly change of one series against the changes
 * of the ANOMALY_BASELINE_HOURS before it.
 *
 * The centre and the spread are the median and the median absolute
 * deviation, so one earlier spike does not widen the baseline and hide the
 * next one. A baseline whose spread is zero cannot rank a change and is
 * reported as LOW quality with no signal.
 */
export function computeSeriesAnomaly(input: { label: string; points: readonly SourcedPoint[]; at: Date }): AnomalyReading {
  const currentHour = Math.floor(input.at.getTime() / HOUR_MS);
  const changes = hourlyChanges(input.points);
  // The hour in progress is not complete: its last observation is not known yet.
  let newest: number | null = null;
  for (const hour of changes.keys()) if (hour < currentHour && (newest === null || hour > newest)) newest = hour;
  if (newest === null || currentHour - newest > ANOMALY_MAX_AGE_HOURS) return { signals: [], qualityGrade: "LOW", changeHour: null, source: null };

  const { change, source } = changes.get(newest)!;
  const changeHour = new Date(newest * HOUR_MS).toISOString();
  const baseline: number[] = [];
  for (let hour = newest - ANOMALY_BASELINE_HOURS; hour < newest; hour++) {
    const entry = changes.get(hour);
    if (entry && entry.source === source) baseline.push(entry.change);
  }
  if (baseline.length < ANOMALY_MIN_BASELINE_CHANGES) return { signals: [], qualityGrade: "LOW", changeHour, source };
  const centre = median(baseline);
  const spread = median(baseline.map((value) => Math.abs(value - centre)));
  if (!(spread > 0)) return { signals: [], qualityGrade: "LOW", changeHour, source };

  const qualityGrade = baseline.length >= ANOMALY_BASELINE_HOURS * 0.75 ? "HIGH" : "MEDIUM";
  const score = (MAD_SCALE * (change - centre)) / spread;
  if (Math.abs(score) < ANOMALY_Z_THRESHOLD) return { signals: [], qualityGrade, changeHour, source };

  const up = score > 0;
  const percent = (Math.exp(change) - 1) * 100;
  const typical = (Math.exp(spread / MAD_SCALE) - 1) * 100;
  return { qualityGrade, changeHour, source, signals: [{
    type: up ? "SERIES_ANOMALY_UP" : "SERIES_ANOMALY_DOWN",
    severity: clamp(Math.round(10 * Math.abs(score)), 0, 100),
    confidence: round(clamp(baseline.length / ANOMALY_BASELINE_HOURS, 0, 1), 3),
    title: `${input.label}: unusual hourly ${up ? "rise" : "fall"}`,
    summary: `${input.label} changed ${round(percent)}% in the hour to ${new Date((newest + 1) * HOUR_MS).toISOString().slice(0, 16)}Z. Against its ${baseline.length} hourly changes of the ${ANOMALY_BASELINE_HOURS} hours before, that is ${round(Math.abs(score), 1)} robust standard deviations from the median; a typical hour moves about ${round(typical)}%.`,
    evidence: [
      { key: "change_percent", value: round(percent, 3), label: "Change in the hour, %" },
      { key: "robust_z", value: round(score), label: "Modified z-score" },
      { key: "threshold", value: ANOMALY_Z_THRESHOLD, label: "Threshold, modified z-score" },
      { key: "baseline_changes", value: baseline.length, label: `Hourly changes in the baseline, of ${ANOMALY_BASELINE_HOURS}` },
      { key: "baseline_median_percent", value: round((Math.exp(centre) - 1) * 100, 4), label: "Median hourly change in the baseline, %" },
      { key: "typical_move_percent", value: round(typical, 3), label: "Typical hourly move in the baseline, %" }
    ],
    engineVersion: ANOMALY_ENGINE_VERSION
  }] };
}
