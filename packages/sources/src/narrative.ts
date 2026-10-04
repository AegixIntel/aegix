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
/**
 * How the source paces itself, and why.
 *
 * GDELT documents one request every five seconds, but that is not what
 * decides whether a request is answered. Measured on 2026-10-02 from the
 * production host and from an unrelated network, it answered HTTP 429 to
 * about four requests in five, each after ten seconds or more, whether they
 * were twenty seconds or an hour apart and whether or not the query had been
 * asked before. A refusal says nothing about the next request.
 *
 * So a sweep asks for exactly one topic, chosen by rotation, and keeps asking
 * at a steady pace until it is answered or its turn is nearly over. At one
 * answer in five, seven attempts get a topic through about four turns in
 * five. The worker sweeps every ten minutes, so each topic has a turn every
 * eighty minutes, and each answer covers three days: a topic can miss many
 * turns in a row before an hour of it is lost.
 *
 * Seven attempts forty seconds apart end inside the turn even when every one
 * of them runs to the timeout, so two sweeps never ask at once.
 */
export const NARRATIVE_ROTATION_MS = 600_000;
export const GDELT_MAX_ATTEMPTS = 7;
export const GDELT_RETRY_WAIT_MS = 40_000;
export const GDELT_TIMESPAN = "3d";
/** A timeline response routinely takes 10–30 seconds. */
export const GDELT_TIMEOUT_MS = 45_000;

/** The topic whose turn it is at `at`. Stateless, so every replica agrees. */
export function narrativeTopicFor(at: Date, topics: readonly NarrativeTopic[] = NARRATIVE_TOPICS, rotationMs = NARRATIVE_ROTATION_MS): NarrativeTopic {
  return topics[Math.floor(at.getTime() / rotationMs) % topics.length]!;
}

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
export function parseGdeltDate(value: unknown): number {
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
  rotationMs?: number;
  /** Injected in tests; production waits before asking a refused topic again. */
  sleep?: (ms: number) => Promise<void>;
  /** Told when the topic whose turn it was ended the sweep with no data, and why. */
  onTopicFailure?: (topicId: string, code: string, attempts: number) => void;
} = {}): SeriesSource {
  const topics = options.topics ?? NARRATIVE_TOPICS;
  const baseUrl = (options.baseUrl ?? "https://api.gdeltproject.org/api/v2").replace(/\/$/, "");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    name: NARRATIVE_SOURCE,
    series: narrativeSeries(topics),
    async collect(at) {
      const topic = narrativeTopicFor(at, topics, options.rotationMs);
      const query = new URLSearchParams({ query: topic.query, mode: "timelinevol", format: "json", timespan: GDELT_TIMESPAN });
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= GDELT_MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) await sleep(GDELT_RETRY_WAIT_MS);
        try {
          const payload = await fetchJson(`${baseUrl}/doc/doc?${query}`, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs ?? GDELT_TIMEOUT_MS });
          return hourlyNarrativeVolume(payload, at).map((point): SeriesObservation => (
            { seriesKey: narrativeSeriesKey(topic.id), eventTime: point.eventTime, value: point.value, source: NARRATIVE_SOURCE }));
        } catch (error) {
          lastError = error;
          const code = error instanceof SourceError ? error.code : "PROVIDER_ERROR";
          // Only a refusal or a timeout is worth asking again; a malformed
          // answer will be malformed the second time too.
          if (code === "MALFORMED_RESPONSE" || attempt === GDELT_MAX_ATTEMPTS) {
            options.onTopicFailure?.(topic.id, code, attempt);
            break;
          }
        }
      }
      // The gap is this topic's alone, and its next turn re-reads three days.
      throw lastError;
    }
  };
}
