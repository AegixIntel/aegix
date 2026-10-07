/**
 * Narrative Radar: where each news topic's coverage stands now, read from the
 * ledger's hourly article counts. See
 * docs/milestone-d15-market-intelligence-engines.md §1.
 *
 * It answers "which topics are being written about more than two days ago",
 * with the same hours and the same acceleration rule the context signal
 * engine stores at capture time. It measures how much is published. It is
 * not sentiment, not social media, and says nothing about whether the
 * coverage is right.
 */

import {
  NARRATIVE_ACCELERATION_RATIO, NARRATIVE_BASELINE_HOURS, NARRATIVE_MIN_BASELINE_HOURS, NARRATIVE_MIN_MENTIONS, NARRATIVE_MIN_RECENT_HOURS,
  NARRATIVE_RECENT_HOURS, narrativeWindows, type LedgerPoint
} from "./context-signals.js";
import type { NarrativeTopic } from "./narrative.js";

export const NARRATIVE_RADAR_VERSION = "narrative-radar-v1.0.0";

const HOUR_MS = 3_600_000;

/** Recent mean over baseline mean at or below which coverage is called fading. */
export const NARRATIVE_FADING_RATIO = 0.5;
/** Hours of counts returned for drawing. */
export const NARRATIVE_RADAR_SERIES_HOURS = 72;

export type NarrativeState = "ACCELERATING" | "STEADY" | "FADING" | "INSUFFICIENT_DATA";

export interface NarrativeRadarEntry {
  topic: string;
  label: string;
  state: NarrativeState;
  /** Articles per hour over the newest settled hours; null when too few are held. */
  recentMean: number | null;
  baselineMean: number | null;
  /** Recent over baseline; null when either mean is missing or the baseline is zero. */
  ratio: number | null;
  recentHours: number;
  baselineHours: number;
  /** Start of the newest hour the ledger holds for this topic; null when it holds none. */
  latestHour: string | null;
  series: Array<{ hour: string; mentions: number }>;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** One topic's standing at `at`, from the counts the ledger holds. */
export function readNarrativeTopic(input: { topic: NarrativeTopic; points: readonly LedgerPoint[]; at: Date }): NarrativeRadarEntry {
  const { recent, baseline } = narrativeWindows(input.points, input.at);
  const from = input.at.getTime() - NARRATIVE_RADAR_SERIES_HOURS * HOUR_MS;
  const byHour = new Map<number, number>();
  for (const point of input.points) {
    const time = Date.parse(point.eventTime);
    if (Number.isFinite(time) && time <= input.at.getTime() && Number.isFinite(point.value) && point.value >= 0) byHour.set(Math.floor(time / HOUR_MS), point.value);
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const entry: NarrativeRadarEntry = {
    topic: input.topic.id, label: input.topic.label, state: "INSUFFICIENT_DATA", recentMean: null, baselineMean: null, ratio: null,
    recentHours: recent.length, baselineHours: baseline.length,
    latestHour: hours.length ? new Date(hours.at(-1)! * HOUR_MS).toISOString() : null,
    series: hours.filter((hour) => hour * HOUR_MS >= from).map((hour) => ({ hour: new Date(hour * HOUR_MS).toISOString(), mentions: byHour.get(hour)! }))
  };
  if (recent.length < NARRATIVE_MIN_RECENT_HOURS || baseline.length < NARRATIVE_MIN_BASELINE_HOURS) return entry;

  const recentMean = mean(recent);
  const baselineMean = mean(baseline);
  entry.recentMean = round(recentMean);
  entry.baselineMean = round(baselineMean);
  entry.state = "STEADY";
  if (baselineMean <= 0) return entry;
  const ratio = recentMean / baselineMean;
  entry.ratio = round(ratio);
  // The same floor in both directions: below it a doubling or a halving is one article.
  if (ratio >= NARRATIVE_ACCELERATION_RATIO && recentMean >= NARRATIVE_MIN_MENTIONS) entry.state = "ACCELERATING";
  else if (ratio <= NARRATIVE_FADING_RATIO && baselineMean >= NARRATIVE_MIN_MENTIONS) entry.state = "FADING";
  return entry;
}

const STATE_ORDER: Record<NarrativeState, number> = { ACCELERATING: 0, FADING: 1, STEADY: 2, INSUFFICIENT_DATA: 3 };

/** Every topic, the ones that are moving first, then by how far from their baseline. */
export function buildNarrativeRadar(input: { topics: readonly NarrativeTopic[]; points: ReadonlyMap<string, readonly LedgerPoint[]>; at: Date }): NarrativeRadarEntry[] {
  return input.topics
    .map((topic) => readNarrativeTopic({ topic, points: input.points.get(topic.id) ?? [], at: input.at }))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
      || Math.abs(Math.log(b.ratio && b.ratio > 0 ? b.ratio : 1)) - Math.abs(Math.log(a.ratio && a.ratio > 0 ? a.ratio : 1))
      || a.topic.localeCompare(b.topic));
}

export const NARRATIVE_RADAR_HORIZON_HOURS = Math.max(NARRATIVE_RADAR_SERIES_HOURS, NARRATIVE_RECENT_HOURS + NARRATIVE_BASELINE_HOURS + 4);
