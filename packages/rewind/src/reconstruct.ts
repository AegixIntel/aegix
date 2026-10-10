/**
 * Reconstruction: what the signal engine shows when it is run now over
 * provider history, for the part of a window that has no stored capture.
 * See docs/milestone-d14-rewind-discovery.md §3b.
 *
 * This is not a replay and is never presented as one. A replay reads what
 * AEGIX stored at the time. A reconstruction is computed at request time,
 * with the engine as it is today, from ledger rows that may have been loaded
 * long after the hours they describe. It keeps the one rule that can still
 * be kept: for each hour, the engine is given nothing later than that hour.
 *
 * It answers "what does the engine say about that history", not "what did
 * AEGIX know". The two are returned side by side and never merged.
 */

import type { CaptureRecord, CapturedSignal } from "./replay.js";

const HOUR_MS = 3_600_000;

/** Hours of history the engine is given at each step, as a capture gives it. */
export const RECONSTRUCTION_HISTORY_HOURS = 24;

export interface ReconstructionPoint { eventTime: string; value: number; source: string }

export interface ReconstructionEngineInput {
  currentPrice: number;
  currentVolume: number | null;
  history: Array<{ timestamp: string; priceUsd: number; volumeUsd: number | null }>;
}

export interface ReconstructionInput {
  /** The hours to reconstruct: [from, to). `to` is never later than the event. */
  from: string;
  to: string;
  price: readonly ReconstructionPoint[];
  volume: readonly ReconstructionPoint[];
  engineVersion: string;
  compute(input: ReconstructionEngineInput): CapturedSignal[];
}

export interface Reconstruction {
  /** One per hour that had a price, stamped at the end of that hour. */
  captures: CaptureRecord[];
  /** The providers the hours were read from, as the ledger names them. */
  sources: string[];
  /** Hours that had a price and were given to the engine. */
  hours: number;
}

/** Last value of each hour, per source. */
function hourly(points: readonly ReconstructionPoint[]): Map<string, Map<number, number>> {
  const bySource = new Map<string, Map<number, { at: number; value: number }>>();
  for (const point of points) {
    const at = Date.parse(point.eventTime);
    if (!Number.isFinite(at) || !Number.isFinite(point.value) || point.value <= 0) continue;
    const hours = bySource.get(point.source) ?? new Map<number, { at: number; value: number }>();
    const hour = Math.floor(at / HOUR_MS);
    const held = hours.get(hour);
    if (!held || at >= held.at) hours.set(hour, { at, value: point.value });
    bySource.set(point.source, hours);
  }
  return new Map([...bySource].map(([source, hours]) => [source, new Map([...hours].map(([hour, p]) => [hour, p.value]))]));
}

/**
 * Runs the engine once per hour of [from, to). An hour is given its own
 * price, and the hours before it from the same provider only: two providers'
 * volumes differ by a constant that would read as one large move at the seam.
 * An hour ends before it is stamped, so nothing is stamped at or after `to`.
 */
export function reconstructCaptures(input: ReconstructionInput): Reconstruction {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const prices = hourly(input.price);
  const volumes = hourly(input.volume);
  const captures: CaptureRecord[] = [];
  const sources = new Set<string>();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { captures, sources: [], hours: 0 };

  for (let hour = Math.ceil(fromMs / HOUR_MS); (hour + 1) * HOUR_MS < toMs; hour++) {
    // The provider with a price in this hour; with two, the one with more history behind it.
    let chosen: { source: string; depth: number } | null = null;
    for (const [source, series] of prices) {
      if (!series.has(hour)) continue;
      let depth = 0;
      for (let back = 1; back <= RECONSTRUCTION_HISTORY_HOURS; back++) if (series.has(hour - back)) depth += 1;
      if (!chosen || depth > chosen.depth) chosen = { source, depth };
    }
    if (!chosen) continue;
    const price = prices.get(chosen.source)!;
    const volume = volumes.get(chosen.source);
    const history: ReconstructionEngineInput["history"] = [];
    for (let back = RECONSTRUCTION_HISTORY_HOURS; back >= 1; back--) {
      const value = price.get(hour - back);
      if (value !== undefined) history.push({ timestamp: new Date((hour - back) * HOUR_MS).toISOString(), priceUsd: value, volumeUsd: volume?.get(hour - back) ?? null });
    }
    sources.add(chosen.source);
    captures.push({
      id: `reconstructed:${new Date(hour * HOUR_MS).toISOString()}`,
      observedAt: new Date((hour + 1) * HOUR_MS).toISOString(),
      engineVersion: input.engineVersion,
      qualityGrade: history.length >= RECONSTRUCTION_HISTORY_HOURS ? "HIGH" : history.length >= 7 ? "MEDIUM" : "LOW",
      providerStatus: "RECONSTRUCTED",
      signals: input.compute({ currentPrice: price.get(hour)!, currentVolume: volume?.get(hour) ?? null, history })
    });
  }
  return { captures, sources: [...sources].sort(), hours: captures.length };
}
