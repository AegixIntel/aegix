/**
 * Narrative mentions from the GDELT Context 2.0 API.
 *
 * A second reading of the same eight topics, from a different GDELT index.
 * The DOC 2.0 index behind `narrative.ts` stopped taking articles on
 * 2 October 2026 while this one kept current, so the two are captured side
 * by side and neither stands in for the other.
 *
 * The measure is different and so is the series: the number of distinct
 * articles GDELT saw in one hour with a sentence matching the topic's query.
 * It is a count, not a share. The Context API has no timeline mode and
 * covers a subset of what DOC 2.0 searches, so the counts are small — one to
 * thirty an hour for these topics, measured on 4 October 2026 — and an hour
 * of a narrow topic is often zero.
 *
 * Each hour is asked for on its own. A wider window is answered with fewer
 * articles than its hours hold, cut off at a depth the API does not report,
 * while a one-hour window returned the same count each time it was asked.
 *
 * The API keeps 72 hours. An hour not read in that time cannot be read later.
 */

import type { SeriesDescriptor } from "@aegix/rewind";
import { GDELT_TIMEOUT_MS, NARRATIVE_ROTATION_MS, NARRATIVE_TOPICS, gdeltFetch, narrativeTopicFor, parseGdeltDate, type NarrativeTopic } from "./narrative.js";
import { SourceError, fetchJson, type SeriesObservation, type SeriesSource } from "./types.js";

export const NARRATIVE_CONTEXT_SOURCE = "gdelt-context-v2";

const HOUR_MS = 3_600_000;
/**
 * A topic has a turn every eighty minutes and each turn asks for the last
 * three settled hours, so every hour is asked for in two turns and one
 * missed turn loses nothing. The ledger keeps the first answer.
 */
export const CONTEXT_HOURS_PER_SWEEP = 3;
/**
 * Articles reached the index about fifteen minutes after GDELT saw them. An
 * hour is asked for once it has been over for an hour; asked earlier, a low
 * count would be stored and kept.
 */
export const CONTEXT_SETTLE_MS = HOUR_MS;
/** GDELT documents one request every five seconds. */
export const CONTEXT_REQUEST_GAP_MS = 6_000;
/** The most the API returns. A full page is a count that was cut off. */
export const CONTEXT_MAX_RECORDS = 200;

export function narrativeContextSeriesKey(topicId: string): string {
  return `narrative:${topicId}:context_mentions`;
}

export function narrativeContextSeries(topics: readonly NarrativeTopic[] = NARRATIVE_TOPICS): SeriesDescriptor[] {
  return topics.map((t) => ({ key: narrativeContextSeriesKey(t.id), label: `${t.label} news mentions per hour`, group: `narrative:${t.id}` }));
}

/** 2026-10-04T03:00:00.000Z → 20261004030000 */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);

/**
 * Distinct articles seen in [fromMs, toMs). Null when the page is full: the
 * API stopped at its limit and the hour's count is not known.
 */
export function contextMentionCount(payload: unknown, fromMs: number, toMs: number): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SourceError("MALFORMED_RESPONSE", "GDELT context response is not an object");
  const articles = (payload as { articles?: unknown }).articles;
  // An hour with no match is answered without the list.
  if (articles === undefined) return 0;
  if (!Array.isArray(articles)) throw new SourceError("MALFORMED_RESPONSE", "GDELT context articles are missing");
  if (articles.length >= CONTEXT_MAX_RECORDS) return null;
  const urls = new Set<string>();
  for (const article of articles as Array<{ url?: unknown; seendate?: unknown }>) {
    const seen = parseGdeltDate(article?.seendate);
    if (typeof article?.url === "string" && seen >= fromMs && seen < toMs) urls.add(article.url);
  }
  return urls.size;
}

export function createNarrativeContextSource(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  topics?: readonly NarrativeTopic[];
  rotationMs?: number;
  /** Injected in tests; production spaces its requests. */
  sleep?: (ms: number) => Promise<void>;
  /** Told when an hour of the topic whose turn it was could not be read, and why. */
  onHourFailure?: (topicId: string, eventTime: string, code: string) => void;
} = {}): SeriesSource {
  const topics = options.topics ?? NARRATIVE_TOPICS;
  const baseUrl = (options.baseUrl ?? "https://api.gdeltproject.org/api/v2").replace(/\/$/, "");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    name: NARRATIVE_CONTEXT_SOURCE,
    series: narrativeContextSeries(topics),
    async collect(at) {
      const topic = narrativeTopicFor(at, topics, options.rotationMs ?? NARRATIVE_ROTATION_MS);
      const settledHour = Math.floor((at.getTime() - CONTEXT_SETTLE_MS) / HOUR_MS);
      const observations: SeriesObservation[] = [];
      let answered = 0;
      let lastError: unknown = null;
      for (let back = 1; back <= CONTEXT_HOURS_PER_SWEEP; back++) {
        if (back > 1) await sleep(CONTEXT_REQUEST_GAP_MS);
        const fromMs = (settledHour - back) * HOUR_MS;
        const toMs = fromMs + HOUR_MS;
        const query = new URLSearchParams({
          query: topic.query, mode: "artlist", format: "json", maxrecords: String(CONTEXT_MAX_RECORDS),
          startdatetime: stamp(fromMs), enddatetime: stamp(toMs)
        });
        try {
          const payload = await fetchJson(`${baseUrl}/context/context?${query}`, { fetchImpl: options.fetchImpl ?? gdeltFetch, timeoutMs: options.timeoutMs ?? GDELT_TIMEOUT_MS });
          answered += 1;
          const count = contextMentionCount(payload, fromMs, toMs);
          // Zero is not written. The engine takes no change from a zero hour,
          // and an index that has stopped answers zero too: the ledger would
          // hold a reading that was really a gap.
          if (count !== null && count > 0) {
            observations.push({ seriesKey: narrativeContextSeriesKey(topic.id), eventTime: new Date(fromMs).toISOString(), value: count, source: NARRATIVE_CONTEXT_SOURCE });
          }
        } catch (error) {
          lastError = error;
          options.onHourFailure?.(topic.id, new Date(fromMs).toISOString(), error instanceof SourceError ? error.code : "PROVIDER_ERROR");
        }
      }
      // An hour that failed is asked for again on the topic's next turn. A
      // sweep in which nothing was answered is a failed sweep.
      if (answered === 0 && lastError) throw lastError;
      return observations;
    }
  };
}
