/**
 * Writes GDELT history for the narrative series to a CSV, to be loaded into
 * observation_points once with scripts/backfill-narrative-history.sql
 * (docs/milestone-d14-rewind-discovery.md §4b).
 *
 * This is the same provider, endpoint and measure the live source reads, so
 * the rows carry the live source's name and there is no seam between
 * providers. Only the window differs: the live source asks for the last three
 * days, this asks for explicit windows further back. A window under 72 hours
 * is answered at 15-minute resolution, which is what the hourly mean needs;
 * a longer one comes back daily.
 *
 * GDELT refuses most requests whatever their pace, so each window is asked
 * again until it is answered. A window GDELT has no data for is answered
 * with an empty object and writes nothing.
 *
 *   node --import tsx scripts/backfill-narrative-history.ts \
 *     --from 2026-09-20T00:00:00Z --to 2026-09-30T00:00:00Z --out narrative.csv
 */

import { writeFileSync } from "node:fs";
import {
  GDELT_TIMEOUT_MS, NARRATIVE_SOURCE, NARRATIVE_TOPICS, SourceError, fetchJson, hourlyNarrativeVolume, narrativeSeriesKey
} from "../packages/sources/src/index.js";

const HOUR_MS = 3_600_000;
/** Under the 72 hours at which GDELT switches from 15-minute to coarser steps. */
const WINDOW_HOURS = 60;
const ATTEMPTS_PER_WINDOW = 40;
const WAIT_MS = 15_000;

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function time(name: string): number {
  const ms = Date.parse(arg(name));
  if (!Number.isFinite(ms) || ms % HOUR_MS !== 0) throw new Error(`--${name} must be a whole UTC hour`);
  return ms;
}

/** 2026-09-20T00:00:00.000Z → 20260920000000 */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);

async function windowRows(query: string, seriesKey: string, fromMs: number, toMs: number): Promise<string[] | null> {
  const params = new URLSearchParams({ query, mode: "timelinevol", format: "json", startdatetime: stamp(fromMs), enddatetime: stamp(toMs) });
  for (let attempt = 1; attempt <= ATTEMPTS_PER_WINDOW; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    try {
      const payload = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { timeoutMs: GDELT_TIMEOUT_MS });
      if (payload && typeof payload === "object" && Object.keys(payload).length === 0) return [];
      return hourlyNarrativeVolume(payload, new Date(toMs))
        .filter((point) => Date.parse(point.eventTime) >= fromMs)
        .map((point) => `${seriesKey},${point.eventTime},${point.value},${NARRATIVE_SOURCE}`);
    } catch (error) {
      if (error instanceof SourceError && error.code === "MALFORMED_RESPONSE") throw error;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const fromMs = time("from");
  const toMs = time("to");
  const out = arg("out");
  const rows: string[] = [];
  const failures: string[] = [];

  for (const topic of NARRATIVE_TOPICS) {
    let count = 0;
    for (let start = fromMs; start < toMs; start += WINDOW_HOURS * HOUR_MS) {
      const end = Math.min(toMs, start + WINDOW_HOURS * HOUR_MS);
      const window = await windowRows(topic.query, narrativeSeriesKey(topic.id), start, end).catch(() => null);
      if (window === null) failures.push(`${topic.id} ${new Date(start).toISOString()}`);
      else { rows.push(...window); count += window.length; }
      // Written as it goes: a run interrupted by refusals keeps what it has.
      writeFileSync(out, rows.join("\n") + (rows.length > 0 ? "\n" : ""));
    }
    console.log(`${new Date().toISOString().slice(11, 19)} ${topic.id} ${count}`);
  }
  console.log(`rows ${rows.length}, failures ${failures.length}`);
  for (const failure of failures) console.error(`FAILED ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "backfill failed"); process.exitCode = 1; });
