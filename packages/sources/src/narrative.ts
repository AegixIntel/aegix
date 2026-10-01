/**
 * Narrative volume from the GDELT DOC 2.0 API.
 *
 * One series per topic: the share of monitored global online news coverage
 * matching the topic's query, per hour. "Narrative velocity" is then the
 * change in that share, which is what the Discovery Engine differences.
 *
 * This measures how much is being published. It is not sentiment, not social
 * media, and not a judgement of whether the coverage is accurate.
 *
 * The topic list is part of the hypothesis set: adding a topic because a
 * story is already trending would be choosing the hypothesis after seeing
 * the data.
 */

import type { SeriesDescriptor } from "@aegix/rewind";
import { SourceError, fetchJson, type SeriesObservation, type SeriesSource } from "./types.js";

export const NARRATIVE_SOURCE = "gdelt-doc-v2";
/** GDELT asks for at most one request every five seconds. */
export const GDELT_MIN_INTERVAL_MS = 5_500;

export interface NarrativeTopic { id: string; label: string; query: string }

export const NARRATIVE_TOPICS: readonly NarrativeTopic[] = [
  { id: "data-center", label: "Data center", query: "\"data center\"" },
  { id: "ai-infrastructure", label: "AI infrastructure", query: "\"AI infrastructure\"" },
  { id: "semiconductor", label: "Semiconductor", query: "semiconductor" },
  { id: "power-grid", label: "Power grid", query: "\"power grid\"" },
  { id: "copper", label: "Copper", query: "copper" },
  { id: "uranium", label: "Uranium", query: "uranium" },
  { id: "bitcoin", label: "Bitcoin", query: "bitcoin" },
  { id: "stablecoin", label: "Stablecoin", query: "stablecoin" }
];

export function narrativeSeriesKey(topicId: string): string {
  return `narrative:${topicId}:news_volume_share`;
}

export function narrativeSeries(topics: readonly NarrativeTopic[] = NARRATIVE_TOPICS): SeriesDescriptor[] {
  return topics.map((t) => ({ key: narrativeSeriesKey(t.id), label: `${t.label} news volume share`, group: `narrative:${t.id}` }));
}

/** "20260928T090000Z" → epoch ms, or NaN. */
function parseGdeltDate(value: unknown): number {
  const m = typeof value === "string" ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value) : null;
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : Number.NaN;
}

/**
 * Hourly mean of GDELT's 15-minute volume intensity. Only hours that ended
 * before `at` are returned: the current hour is still filling.
 */
export function hourlyNarrativeVolume(payload: unknown, at: Date): Array<{ eventTime: string; value: number }> {
  const timeline = (payload as { timeline?: Array<{ data?: Array<{ date?: unknown; value?: unknown }> }> } | null)?.timeline;
  const data = Array.isArray(timeline) ? timeline[0]?.data : undefined;
  if (!Array.isArray(data)) throw new SourceError("MALFORMED_RESPONSE", "GDELT timeline is missing");
  const currentHour = Math.floor(at.getTime() / 3_600_000);
  const hours = new Map<number, { sum: number; count: number }>();
  for (const point of data) {
    const time = parseGdeltDate(point.date);
    if (!Number.isFinite(time) || typeof point.value !== "number" || !Number.isFinite(point.value) || point.value < 0) continue;
    const hour = Math.floor(time / 3_600_000);
    if (hour >= currentHour) continue;
    const bucket = hours.get(hour) ?? { sum: 0, count: 0 };
    bucket.sum += point.value; bucket.count += 1;
    hours.set(hour, bucket);
  }
  return [...hours.entries()].sort((a, b) => a[0] - b[0])
    .map(([hour, b]) => ({ eventTime: new Date(hour * 3_600_000).toISOString(), value: b.sum / b.count }));
}

export function createNarrativeSource(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  topics?: readonly NarrativeTopic[];
  /** Injected in tests; production waits out GDELT's request spacing. */
  sleep?: (ms: number) => Promise<void>;
} = {}): SeriesSource {
  const topics = options.topics ?? NARRATIVE_TOPICS;
  const baseUrl = (options.baseUrl ?? "https://api.gdeltproject.org/api/v2").replace(/\/$/, "");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    name: NARRATIVE_SOURCE,
    series: narrativeSeries(topics),
    async collect(at) {
      const observations: SeriesObservation[] = [];
      let failures = 0;
      for (const [index, topic] of topics.entries()) {
        if (index > 0) await sleep(GDELT_MIN_INTERVAL_MS);
        const query = new URLSearchParams({ query: topic.query, mode: "timelinevol", format: "json", timespan: "2d" });
        try {
          const payload = await fetchJson(`${baseUrl}/doc/doc?${query}`, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
          for (const point of hourlyNarrativeVolume(payload, at)) {
            observations.push({ seriesKey: narrativeSeriesKey(topic.id), eventTime: point.eventTime, value: point.value, source: NARRATIVE_SOURCE });
          }
        } catch (error) {
          // One topic failing leaves a gap in that topic, not in all of them.
          failures += 1;
          if (failures === topics.length) throw error;
        }
      }
      return observations;
    }
  };
}
