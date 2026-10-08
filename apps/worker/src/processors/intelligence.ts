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
  CONTEXT_ENGINE_VERSION, NARRATIVE_BASELINE_HOURS, NARRATIVE_CONTEXT_SOURCE, NARRATIVE_RECENT_HOURS, NARRATIVE_TOPICS, QUOTED_FUNDS, SECTOR_QUOTES_SOURCE,
  TOKENIZED_STOCKS, computeFundSignals, computeNarrativeSignals, fundPriceSeriesKey, narrativeContextSeries, narrativeContextSeriesKey, narrativeSeries,
  narrativeTopicFor, optionsSeries, sectorQuoteSeries, tokenizedStockSeries, tokenizedStockSeriesKey, usEquitySessionOpen,
  type ContextSignal, type NarrativeTopic, type QuotedFund, type SeriesSource, type TokenizedStock
} from "@aegix/sources";
import {
  DISCOVERY_FDR_LEVEL, HOURLY_PROFILE, epochEndFor, parseCalendars, runScan, scanHorizonHours, submitToCalendar,
  type Direction, type DiscoveryProfile
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

const HOUR_MS = 3_600_000;

const storedSignals = (signals: ContextSignal[]) => signals.map((s) => ({
  type: s.type, severity: s.severity, confidence: s.confidence, title: s.title,
  summary: s.summary, evidence: s.evidence, engineVersion: s.engineVersion
}));

/**
 * Stores one capture of the news topic whose turn the context source just
 * took, so Rewind can replay what its coverage was doing. One per topic per
 * hour. The reading is made here, once, from the ledger as it stands; a
 * topic with too few hours on record is stored as a capture with no signal
 * and LOW quality, which is what was knowable.
 */
export async function captureNarrativeSignals(
  ctx: IntelligenceContext,
  at: Date = new Date(),
  topics: readonly NarrativeTopic[] = NARRATIVE_TOPICS
): Promise<CaptureResult> {
  const repo = createObservationRepo(ctx.sql);
  const topic = narrativeTopicFor(at, topics);
  const key = narrativeContextSeriesKey(topic.id);
  const from = new Date(at.getTime() - (NARRATIVE_RECENT_HOURS + NARRATIVE_BASELINE_HOURS + 4) * HOUR_MS).toISOString();
  const rows = await repo.pointsBetween([key], from, at.toISOString());
  const points = rows.filter((r) => r.source === NARRATIVE_CONTEXT_SOURCE).map((r) => ({ eventTime: new Date(r.event_time).toISOString(), value: Number(r.value) }));
  const reading = computeNarrativeSignals({ topic, points, at });
  const stored = await repo.recordCapture({
    domain: "NARRATIVE",
    subject: topic.id,
    bucketStart: new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString(),
    engineVersion: CONTEXT_ENGINE_VERSION,
    provider: NARRATIVE_CONTEXT_SOURCE,
    providerStatus: "OK",
    qualityGrade: reading.qualityGrade,
    signals: storedSignals(reading.signals)
  });
  return { captured: stored ? 1 : 0, skipped: stored ? 0 : 1, failed: 0, pointsAdded: 0 };
}

/**
 * Stores one capture per sector and commodity fund that has a price today,
 * once an hour while the US session is open. Outside it the feed stands
 * still, the source reads nothing, and no capture is written.
 */
export async function captureFundSignals(
  ctx: IntelligenceContext,
  at: Date = new Date(),
  funds: readonly QuotedFund[] = QUOTED_FUNDS
): Promise<CaptureResult> {
  const result: CaptureResult = { captured: 0, skipped: 0, failed: 0, pointsAdded: 0 };
  if (!usEquitySessionOpen(at)) return result;
  const repo = createObservationRepo(ctx.sql);
  const from = new Date(at.getTime() - 8 * 24 * HOUR_MS).toISOString();
  const rows = await repo.pointsBetween(funds.map((f) => fundPriceSeriesKey(f.symbol)), from, new Date(at.getTime() + 1).toISOString());
  const points = new Map(funds.map((f) => {
    const key = fundPriceSeriesKey(f.symbol);
    return [f.symbol, rows.filter((r) => r.series_key === key && r.source === SECTOR_QUOTES_SOURCE)
      .map((r) => ({ eventTime: new Date(r.event_time).toISOString(), value: Number(r.value) }))] as const;
  }));
  const readings = computeFundSignals({ funds, points, at });
  const bucketStart = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString();
  for (const fund of funds) {
    const reading = readings.get(fund.symbol);
    // No price today: nobody looked at this fund in this sweep.
    if (!reading || Date.parse(reading.currentAt) < Date.parse(bucketStart)) { result.skipped += 1; continue; }
    const stored = await repo.recordCapture({
      domain: "SECTOR",
      subject: fund.symbol,
      bucketStart,
      engineVersion: CONTEXT_ENGINE_VERSION,
      provider: SECTOR_QUOTES_SOURCE,
      providerStatus: "OK",
      qualityGrade: reading.qualityGrade,
      signals: storedSignals(reading.signals)
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
    ...(config.ENABLE_OPTIONS_CAPTURE ? optionsSeries() : []),
    ...(config.ENABLE_SECTOR_CAPTURE ? sectorQuoteSeries() : [])
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

/** Runs one profile's scan for the last completed epoch, once. */
export async function runDiscoverySweep(ctx: IntelligenceContext, now: Date = new Date(), profile: DiscoveryProfile = HOURLY_PROFILE): Promise<DiscoverySweepResult> {
  const { sql } = ctx;
  const discoveryRepo = createDiscoveryRepo(sql);
  const observationRepo = createObservationRepo(sql);
  const epochEnd = epochEndFor(now).toISOString();
  if (await discoveryRepo.runExists(profile.engineVersion, epochEnd)) return { ran: false, epochEnd };

  const descriptors = discoverySeries(ctx.config);
  if (descriptors.length < 2) return { ran: false, epochEnd };
  const from = new Date(Date.parse(epochEnd) - scanHorizonHours(profile) * 3_600_000).toISOString();
  const rows = await observationRepo.pointsBetween(descriptors.map((d) => d.key), from, epochEnd);
  const series = descriptors.map((d) => ({
    ...d,
    points: rows.filter((r) => r.series_key === d.key).map((r) => ({ eventTime: new Date(r.event_time).toISOString(), value: Number(r.value) }))
  }));
  const open = (await discoveryRepo.listOpen(profile.engineVersion)).map((d) => ({
    pairKey: d.pair_key, lagHours: d.lag_hours, direction: d.direction as Direction, windowEnd: new Date(d.window_end).toISOString()
  }));

  const scan = runScan({ series, epochEnd, open }, profile);
  const persisted = await discoveryRepo.persistRun({
    engineVersion: scan.engineVersion,
    epochEnd,
    windowHours: profile.windowHours,
    baselineHours: profile.baselineHours,
    fdrLevel: DISCOVERY_FDR_LEVEL,
    method: profile.method,
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

export interface AnchorSweepResult {
  /** The chain head that was looked at, as a Discovery row id; null when no discovery exists. */
  head: string | null;
  submitted: number;
  failed: number;
}

/**
 * Sends the head of the Discovery ID chain to each configured calendar that
 * does not hold it yet, and stores the receipts. A calendar that fails is
 * asked again on the next sweep; the others keep their receipts.
 */
export async function anchorDiscoveryChain(
  ctx: IntelligenceContext,
  submit: (calendarUrl: string, chainHash: string) => Promise<Uint8Array> = (url, hash) => submitToCalendar(url, hash, { timeoutMs: ctx.config.SERIES_SOURCE_TIMEOUT_MS })
): Promise<AnchorSweepResult> {
  const repo = createDiscoveryRepo(ctx.sql);
  const head = await repo.chainHead();
  if (!head) return { head: null, submitted: 0, failed: 0 };
  const held = new Set(await repo.anchoredCalendars(head.chain_hash));
  const result: AnchorSweepResult = { head: head.id, submitted: 0, failed: 0 };
  for (const calendarUrl of parseCalendars(ctx.config.DISCOVERY_ANCHOR_CALENDARS)) {
    if (held.has(calendarUrl)) continue;
    try {
      const receipt = await submit(calendarUrl, head.chain_hash);
      if (await repo.recordAnchor({ discoveryId: head.id, chainHash: head.chain_hash, calendarUrl, receipt })) result.submitted += 1;
    } catch (error) {
      result.failed += 1;
      ctx.logger.warn("discovery chain anchor not stored", { calendar: calendarUrl, error: error instanceof Error ? error.message : "unknown" });
    }
  }
  return result;
}
