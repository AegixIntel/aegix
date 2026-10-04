/**
 * D14 scheduled intelligence, see docs/milestone-d14-rewind-discovery.md.
 *
 * Two sweeps, both safe to run on several worker replicas at once:
 *
 * - capture: stores what the market signal engine sees right now. A capture
 *   is keyed by (subject, time bucket, engine version) and a ledger point by
 *   (series, event time, source), so a second replica writes nothing.
 * - discovery: runs one scan per epoch. The run row is unique per
 *   (engine version, epoch), so a second replica's transaction is a no-op.
 *
 * Neither sweep ever updates a row. What was stored is what Rewind replays.
 */

import type { AppConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";
import { createDiscoveryRepo, createObservationRepo, type Sql } from "@aegix/database";
import { CANONICAL_ASSETS, MARKETS_ENGINE_VERSION, computeMarketSignals, createMarketService, type MarketDataProvider } from "@aegix/markets";
import { marketSeries, marketSeriesKey, type SeriesDescriptor } from "@aegix/rewind";
import {
  TOKENIZED_STOCKS, narrativeContextSeries, narrativeSeries, optionsSeries, tokenizedStockSeries, tokenizedStockSeriesKey,
  type SeriesSource, type TokenizedStock
} from "@aegix/sources";
import {
  DISCOVERY_BASELINE_HOURS, DISCOVERY_ENGINE_VERSION, DISCOVERY_FDR_LEVEL, DISCOVERY_METHOD, DISCOVERY_WINDOW_HOURS,
  epochEndFor, runScan, scanHorizonHours, type Direction
} from "@aegix/discovery";

export interface IntelligenceContext {
  config: AppConfig;
  sql: Sql;
  logger: AegixLogger;
}

export interface CaptureResult { captured: number; skipped: number; failed: number; pointsAdded: number }

/** Stores one capture per market asset for the current time bucket. */
export async function captureMarketSignals(
  ctx: IntelligenceContext,
  provider: MarketDataProvider,
  now: Date = new Date()
): Promise<CaptureResult> {
  const { config, sql, logger } = ctx;
  const repo = createObservationRepo(sql);
  // A fresh service per sweep: the capture must reflect the provider now, not
  // a reading cached by an earlier sweep.
  const service = createMarketService({ provider, now: () => now, cacheSeconds: 1 });
  const intervalMs = config.REWIND_CAPTURE_INTERVAL_SECONDS * 1000;
  const bucketStart = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs).toISOString();
  const result: CaptureResult = { captured: 0, skipped: 0, failed: 0, pointsAdded: 0 };

  for (const asset of CANONICAL_ASSETS) {
    try {
      const snapshot = await service.getSnapshot(asset);
      // Only a first-hand provider reading enters the ledger. A degraded
      // snapshot is the service replaying its own cache, which is not a new
      // observation.
      if (snapshot.providerStatus === "OK") {
        const points = snapshot.history.flatMap((p) => [
          { seriesKey: marketSeriesKey(asset, "price_usd"), eventTime: p.timestamp, value: p.priceUsd, source: snapshot.quote.provider },
          ...(p.volumeUsd !== null && p.volumeUsd > 0
            ? [{ seriesKey: marketSeriesKey(asset, "volume_24h_usd"), eventTime: p.timestamp, value: p.volumeUsd, source: snapshot.quote.provider }]
            : [])
        ]);
        result.pointsAdded += await repo.appendPoints(points);
      }
      const stored = await repo.recordCapture({
        domain: "MARKET",
        subject: asset,
        bucketStart,
        engineVersion: snapshot.engineVersion,
        provider: snapshot.quote.provider,
        providerStatus: snapshot.quote.freshness.status === "UNAVAILABLE" ? "UNAVAILABLE" : snapshot.providerStatus,
        qualityGrade: snapshot.quality.grade,
        signals: snapshot.signals.map((s) => ({
          type: s.type, severity: s.severity, confidence: s.confidence, title: s.title,
          summary: s.summary, evidence: s.evidence, engineVersion: s.engineVersion
        }))
      });
      if (stored) result.captured += 1; else result.skipped += 1;
    } catch (error) {
      // No capture is written for a failed read: a gap in coverage is the
      // truthful record, and Rewind reports gaps.
      result.failed += 1;
      logger.warn("market capture failed", { asset, error: error instanceof Error ? error.message : "unknown" });
    }
  }
  return result;
}

/** Appends whatever one source read to the ledger. A failed read adds nothing. */
export async function captureSeriesSource(ctx: IntelligenceContext, source: SeriesSource, at: Date = new Date()): Promise<{ source: string; read: number; added: number }> {
  const observations = await source.collect(at);
  const added = await createObservationRepo(ctx.sql).appendPoints(observations);
  return { source: source.name, read: observations.length, added };
}

/** Hourly points the market signal engine is given, matching the market assets. */
const SIGNAL_HISTORY_HOURS = 24;

/**
 * Stores one signal capture per tokenized stock, so Rewind can replay them.
 *
 * The signals are computed here, once, from the ledger as it stands at
 * capture time, with the same engine the market assets use. Only price is
 * read on-chain, so the volume signal can never fire for these subjects.
 * A stock whose price was not read in this sweep gets no capture.
 */
export async function captureTokenizedStockSignals(
  ctx: IntelligenceContext,
  at: Date = new Date(),
  stocks: readonly TokenizedStock[] = TOKENIZED_STOCKS
): Promise<CaptureResult> {
  const { config, sql } = ctx;
  const repo = createObservationRepo(sql);
  const intervalMs = config.REWIND_CAPTURE_INTERVAL_SECONDS * 1000;
  const bucketStartMs = Math.floor(at.getTime() / intervalMs) * intervalMs;
  const priced = stocks.filter((s) => s.pool);
  const from = new Date(at.getTime() - (SIGNAL_HISTORY_HOURS + 1) * 3_600_000).toISOString();
  const rows = await repo.pointsBetween(priced.map((s) => tokenizedStockSeriesKey(s.symbol, "price_usdc")), from, new Date(at.getTime() + 1).toISOString());
  const result: CaptureResult = { captured: 0, skipped: 0, failed: 0, pointsAdded: 0 };

  for (const stock of priced) {
    const key = tokenizedStockSeriesKey(stock.symbol, "price_usdc");
    const points = rows.filter((r) => r.series_key === key).map((r) => ({ at: new Date(r.event_time).getTime(), value: Number(r.value), source: r.source }));
    const latest = points.at(-1);
    if (!latest || latest.at < bucketStartMs) { result.skipped += 1; continue; }
    // Last reading of each earlier hour: the same hourly shape the market
    // assets' history has.
    const currentHour = Math.floor(latest.at / 3_600_000);
    const hourly = new Map<number, { at: number; value: number }>();
    for (const p of points) {
      const hour = Math.floor(p.at / 3_600_000);
      if (hour < currentHour) hourly.set(hour, p);
    }
    const history = [...hourly.entries()].sort((a, b) => a[0] - b[0]).slice(-SIGNAL_HISTORY_HOURS)
      .map(([hour, p]) => ({ timestamp: new Date(hour * 3_600_000).toISOString(), priceUsd: p.value, volumeUsd: null }));
    const signals = computeMarketSignals({ asset: stock.symbol, currentPrice: latest.value, currentVolume: null, history });
    const stored = await repo.recordCapture({
      domain: "MARKET",
      subject: stock.symbol,
      bucketStart: new Date(bucketStartMs).toISOString(),
      engineVersion: MARKETS_ENGINE_VERSION,
      provider: latest.source,
      providerStatus: "OK",
      qualityGrade: history.length >= SIGNAL_HISTORY_HOURS ? "HIGH" : history.length >= 7 ? "MEDIUM" : "LOW",
      signals: signals.map((s) => ({
        type: s.type, severity: s.severity, confidence: s.confidence, title: s.title,
        summary: s.summary, evidence: s.evidence, engineVersion: s.engineVersion
      }))
    });
    if (stored) result.captured += 1; else result.skipped += 1;
  }
  return result;
}

/**
 * The series the Discovery Engine scans: exactly those whose capture is
 * switched on. A series nobody is collecting would only add hypotheses that
 * can never be tested.
 */
export function discoverySeries(config: AppConfig): SeriesDescriptor[] {
  return [
    ...(config.ENABLE_REWIND_CAPTURE && config.ENABLE_MARKETS ? marketSeries(CANONICAL_ASSETS) : []),
    ...(config.ENABLE_TOKENIZED_STOCK_CAPTURE ? tokenizedStockSeries() : []),
    ...(config.ENABLE_NARRATIVE_CAPTURE ? narrativeSeries() : []),
    ...(config.ENABLE_NARRATIVE_CONTEXT_CAPTURE ? narrativeContextSeries() : []),
    ...(config.ENABLE_OPTIONS_CAPTURE ? optionsSeries() : [])
  ];
}

export interface DiscoverySweepResult {
  ran: boolean;
  epochEnd: string;
  hypothesesTested?: number;
  rejections?: number;
  discoveries?: number;
  confirmations?: number;
}

/** Runs the scan for the last completed epoch, once. */
export async function runDiscoverySweep(ctx: IntelligenceContext, now: Date = new Date()): Promise<DiscoverySweepResult> {
  const { sql } = ctx;
  const discoveryRepo = createDiscoveryRepo(sql);
  const observationRepo = createObservationRepo(sql);
  const epochEnd = epochEndFor(now).toISOString();
  if (await discoveryRepo.runExists(DISCOVERY_ENGINE_VERSION, epochEnd)) return { ran: false, epochEnd };

  const descriptors = discoverySeries(ctx.config);
  if (descriptors.length < 2) return { ran: false, epochEnd };
  const from = new Date(Date.parse(epochEnd) - scanHorizonHours() * 3_600_000).toISOString();
  const rows = await observationRepo.pointsBetween(descriptors.map((d) => d.key), from, epochEnd);
  const series = descriptors.map((d) => ({
    ...d,
    points: rows.filter((r) => r.series_key === d.key).map((r) => ({ eventTime: new Date(r.event_time).toISOString(), value: Number(r.value) }))
  }));
  const open = (await discoveryRepo.listOpen(DISCOVERY_ENGINE_VERSION)).map((d) => ({
    pairKey: d.pair_key, lagHours: d.lag_hours, direction: d.direction as Direction, windowEnd: new Date(d.window_end).toISOString()
  }));

  const scan = runScan({ series, epochEnd, open });
  const persisted = await discoveryRepo.persistRun({
    engineVersion: scan.engineVersion,
    epochEnd,
    windowHours: DISCOVERY_WINDOW_HOURS,
    baselineHours: DISCOVERY_BASELINE_HOURS,
    fdrLevel: DISCOVERY_FDR_LEVEL,
    method: DISCOVERY_METHOD,
    seriesCount: scan.seriesCount,
    hypothesesConsidered: scan.hypothesesConsidered,
    hypothesesTested: scan.hypothesesTested,
    rejections: scan.rejections,
    tests: scan.tests,
    discoveries: scan.discoveries,
    confirmations: scan.confirmations
  });
  if (!persisted) return { ran: false, epochEnd };
  return {
    ran: true, epochEnd, hypothesesTested: scan.hypothesesTested, rejections: scan.rejections,
    discoveries: persisted.discoveryIds.length, confirmations: scan.confirmations.length
  };
}
