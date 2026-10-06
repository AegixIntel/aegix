import type { ObservationRepo } from "@aegix/database";
import { MARKETS_ENGINE_VERSION, computeMarketSignals } from "@aegix/markets";
import { isTokenizedStockSymbol, tokenizedStockSeriesKey } from "@aegix/sources";
import {
  buildReplay, marketSeriesKey, reconstructCaptures, RECONSTRUCTION_HISTORY_HOURS,
  type ReplayCheckpoint, type ReplayResult
} from "@aegix/rewind";

const HOUR_MS = 3_600_000;

export interface ReplayReconstruction {
  /** The hours reconstructed: from the window start to the first stored capture, or to the event. */
  from: string;
  to: string;
  /** When this was computed. A reconstruction has no earlier existence. */
  computedAt: string;
  engineVersion: string;
  /** The providers the hours were read from, as the ledger names them. */
  sources: string[];
  /** Hours that had a price and were given to the engine. */
  hours: number;
  answer: string;
  checkpoints: ReplayCheckpoint[];
  convergence: ReplayResult["convergence"];
  firstSignal: ReplayResult["firstSignal"];
  limitations: string[];
}

const lead = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

/**
 * The part of a replay's window that AEGIX holds no capture for, run through
 * the signal engine now, from the ledger's provider history. Returned beside
 * the replay and never merged into it: see reconstructCaptures.
 *
 * Null when the window is covered from its first hour, or when the ledger
 * holds no price for the hours that are not.
 */
export async function reconstructReplay(input: {
  repo: ObservationRepo;
  subject: string;
  eventTime: string;
  lookbackHours: number;
  requestedAt: string;
  windowStart: Date;
  lock: Date;
  firstCaptureAt: string | null;
}): Promise<ReplayReconstruction | null> {
  const { repo, subject, windowStart, lock } = input;
  const until = input.firstCaptureAt ? new Date(Math.min(Date.parse(input.firstCaptureAt), lock.getTime())) : lock;
  // Less than two hours without a capture leaves no whole hour to stamp.
  if (until.getTime() - windowStart.getTime() < 2 * HOUR_MS) return null;

  const stock = isTokenizedStockSymbol(subject);
  const priceKey = stock ? tokenizedStockSeriesKey(subject, "price_usdc") : marketSeriesKey(subject, "price_usd");
  const volumeKey = stock ? null : marketSeriesKey(subject, "volume_24h_usd");
  const rows = await repo.pointsBetween(
    volumeKey ? [priceKey, volumeKey] : [priceKey],
    new Date(windowStart.getTime() - (RECONSTRUCTION_HISTORY_HOURS + 1) * HOUR_MS).toISOString(),
    until.toISOString()
  );
  const points = (key: string | null) => rows.filter((r) => r.series_key === key)
    .map((r) => ({ eventTime: new Date(r.event_time).toISOString(), value: Number(r.value), source: r.source }));

  const reconstruction = reconstructCaptures({
    from: windowStart.toISOString(),
    to: until.toISOString(),
    price: points(priceKey),
    volume: points(volumeKey),
    engineVersion: MARKETS_ENGINE_VERSION,
    compute: (step) => computeMarketSignals({ asset: subject, ...step }).map((s) => ({
      type: s.type, severity: s.severity, confidence: s.confidence, title: s.title, summary: s.summary, evidence: s.evidence, engineVersion: s.engineVersion
    }))
  });
  if (reconstruction.captures.length === 0) return null;

  // The same arrangement a replay gets, over the reconstructed hours only.
  const arranged = buildReplay({ subject, eventTime: input.eventTime, lookbackHours: input.lookbackHours, requestedAt: input.requestedAt, captures: reconstruction.captures });
  const answer = arranged.convergence
    ? `Run today over provider history, the engine shows ${arranged.convergence.signalTypes.length} distinct signal types in one hour, ${lead(arranged.convergence.leadSeconds)} before the event.`
    : arranged.firstSignal
      ? `Run today over provider history, the engine first shows a signal ${lead(arranged.firstSignal.leadSeconds)} before the event, and no hour with three distinct signal types.`
      : "Run today over provider history, the engine shows no signal in these hours.";

  return {
    from: windowStart.toISOString(),
    to: until.toISOString(),
    computedAt: input.requestedAt,
    engineVersion: MARKETS_ENGINE_VERSION,
    sources: reconstruction.sources,
    hours: reconstruction.hours,
    answer,
    checkpoints: arranged.checkpoints,
    convergence: arranged.convergence,
    firstSignal: arranged.firstSignal,
    limitations: [
      "This is a reconstruction, not a record. AEGIX stored no capture in these hours; the engine was run when this page was requested, as it is today, and its thresholds were set knowing more than was known then.",
      "The prices it read are provider history. Rows loaded into the ledger after the fact carry the provider's own later corrections, if it made any.",
      "For each hour the engine was given that hour and the hours before it, from one provider, and nothing later. That is the only rule a replay keeps that a reconstruction also keeps.",
      "It does not change the answer above, and it is not evidence of what AEGIX knew.",
      ...(stock ? ["A tokenized stock's history is its price in one on-chain pool, with no volume, so no volume signal can appear."] : [])
    ]
  };
}
