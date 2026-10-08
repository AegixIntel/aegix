import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import { createObservationRepo, type CaptureCoverageRow, type CaptureDomain, type ContextCaptureRow, type ObservationRepo, type Sql } from "@aegix/database";
import { CANONICAL_ASSETS, isCanonicalAsset } from "@aegix/markets";
import { marketSeries, marketSeriesKey } from "@aegix/rewind";
import {
  ANOMALY_BASELINE_HOURS, ANOMALY_ENGINE_VERSION, ANOMALY_MIN_BASELINE_CHANGES, ANOMALY_Z_THRESHOLD, CONFLUENCE_MIN_CLASSES, CONFLUENCE_WINDOW_HOURS,
  CROSS_MARKET_HORIZON_HOURS, NARRATIVE_BASELINE_HOURS, NARRATIVE_CONTEXT_SOURCE, NARRATIVE_RADAR_HORIZON_HOURS, NARRATIVE_RADAR_VERSION,
  NARRATIVE_RECENT_HOURS, NARRATIVE_TOPICS, QUOTED_FUNDS, SECTOR_QUOTES_SOURCE, TOKENIZED_STOCKS, buildCrossMarketView, buildNarrativeRadar,
  buildSignalFeed, fundPriceSeriesKey, narrativeContextSeries, narrativeContextSeriesKey, narrativeSeries, optionsSeries, sectorQuoteSeries,
  tokenizedStockSeries, tokenizedStockSeriesKey, type CrossMarketSeries, type CrossMarketView, type MarketClass, type NarrativeRadarEntry, type SignalDomain, type SourcedPoint
} from "@aegix/sources";

export interface MarketIntelligenceDeps {
  app: FastifyInstance;
  config: AppConfig;
  sql: Sql;
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<{ id: string; isAnonymous: boolean } | null>;
  now?: () => Date;
}

const HOUR_MS = 3_600_000;
/** Signalled captures read for one answer. A week of every subject holding a signal stays under it. */
const FEED_CAPTURES_LIMIT = 5000;
const ANOMALIES_LIMIT = 500;
const NARRATIVE_SIGNALS_DAYS = 7;

const SERIES_LABELS = new Map(
  [...marketSeries(CANONICAL_ASSETS), ...tokenizedStockSeries(), ...narrativeSeries(), ...narrativeContextSeries(), ...optionsSeries(), ...sectorQuoteSeries()]
    .map((series) => [series.key, series.label])
);

const fundClass = (symbol: string): MarketClass | null => {
  const fund = QUOTED_FUNDS.find((f) => f.symbol === symbol);
  return fund ? (fund.group.startsWith("commodity:") ? "COMMODITY_FUND" : "SECTOR_FUND") : null;
};

/** Where a capture's subject sits among the market classes, and its name in words. */
export function resolveSubject(domain: SignalDomain, subject: string): { marketClass: MarketClass; label: string } {
  if (domain === "ANOMALY") {
    const [kind, name] = subject.split(":");
    const marketClass: MarketClass = kind === "market" ? "CRYPTO" : kind === "xstock" ? "TOKENIZED_EQUITY" : kind === "narrative" ? "NEWS" : kind === "fund" ? fundClass(name ?? "") ?? "OTHER" : "OTHER";
    return { marketClass, label: SERIES_LABELS.get(subject) ?? subject };
  }
  if (domain === "NARRATIVE") return { marketClass: "NEWS", label: `${NARRATIVE_TOPICS.find((topic) => topic.id === subject)?.label ?? subject} news coverage` };
  if (domain === "SECTOR") {
    const fund = QUOTED_FUNDS.find((f) => f.symbol === subject);
    return { marketClass: fundClass(subject) ?? "OTHER", label: fund ? `${fund.symbol} fund (${fund.holds})` : subject };
  }
  if (isCanonicalAsset(subject)) return { marketClass: "CRYPTO", label: subject };
  const stock = TOKENIZED_STOCKS.find((s) => s.symbol === subject);
  return stock ? { marketClass: "TOKENIZED_EQUITY", label: `${stock.symbol} (tokenized ${stock.underlying}, on-chain price)` } : { marketClass: "OTHER", label: subject };
}

function coverageView(rows: CaptureCoverageRow[], domain: CaptureDomain) {
  const row = rows.find((r) => r.domain === domain);
  return {
    domain, captures: row?.captures ?? 0, signalled: row?.signalled ?? 0, subjects: row?.subjects ?? 0,
    firstObservedAt: row?.first_observed_at ? new Date(row.first_observed_at).toISOString() : null,
    lastObservedAt: row?.last_observed_at ? new Date(row.last_observed_at).toISOString() : null
  };
}

const signalsOf = (row: ContextCaptureRow) => row.signals.map((s) => ({
  type: s.type, severity: s.severity, confidence: s.confidence, title: s.title, summary: s.summary,
  evidence: Array.isArray(s.evidence) ? s.evidence : [], engineVersion: s.engineVersion
}));

function hoursParam(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(max, Math.floor(parsed)) : fallback;
}

/** The radar's reading of every topic at `at`, from the hourly counts on record. */
/**
 * Anomaly readings of an engine version that has been replaced stay stored,
 * and are not listed: anomaly-v1.0.0 measured thinly traded series against a
 * spread near zero.
 */
export const currentAnomalies = <T extends { domain: string; engine_version: string }>(rows: T[]): T[] =>
  rows.filter((row) => row.domain !== "ANOMALY" || row.engine_version === ANOMALY_ENGINE_VERSION);

export async function loadNarrativeRadar(repo: ObservationRepo, at: Date): Promise<NarrativeRadarEntry[]> {
  const keys = new Map(NARRATIVE_TOPICS.map((topic) => [narrativeContextSeriesKey(topic.id), topic.id]));
  const rows = await repo.pointsBetween([...keys.keys()], new Date(at.getTime() - NARRATIVE_RADAR_HORIZON_HOURS * HOUR_MS).toISOString(), new Date(at.getTime() + 1).toISOString());
  const points = new Map<string, Array<{ eventTime: string; value: number }>>();
  for (const row of rows) {
    if (row.source !== NARRATIVE_CONTEXT_SOURCE) continue;
    const topic = keys.get(row.series_key)!;
    const list = points.get(topic) ?? [];
    list.push({ eventTime: new Date(row.event_time).toISOString(), value: Number(row.value) });
    points.set(topic, list);
  }
  return buildNarrativeRadar({ topics: NARRATIVE_TOPICS, points, at });
}

/** The cross-market view at `at`, over the classes whose price capture is on. */
export async function loadCrossMarketView(repo: ObservationRepo, config: AppConfig, at: Date): Promise<CrossMarketView> {
  const descriptors: Array<Omit<CrossMarketSeries, "points"> & { source?: string }> = [
    ...(config.ENABLE_REWIND_CAPTURE && config.ENABLE_MARKETS ? CANONICAL_ASSETS.map((asset) => ({
      key: marketSeriesKey(asset, "price_usd"), symbol: asset as string, label: `${asset} price (USD)`, marketClass: "CRYPTO" as const, session: false })) : []),
    ...(config.ENABLE_TOKENIZED_STOCK_CAPTURE ? TOKENIZED_STOCKS.filter((s) => s.pool).map((s) => ({
      key: tokenizedStockSeriesKey(s.symbol, "price_usdc"), symbol: s.symbol, label: `${s.symbol} — tokenized ${s.underlying}, price in one on-chain pool`,
      marketClass: s.symbol === "GLDx" ? "TOKENIZED_GOLD" as const : "TOKENIZED_EQUITY" as const, session: false })) : []),
    ...(config.ENABLE_SECTOR_CAPTURE ? QUOTED_FUNDS.map((fund) => ({
      key: fundPriceSeriesKey(fund.symbol), symbol: fund.symbol, label: `${fund.symbol} — fund holding ${fund.holds}`,
      marketClass: fund.group.startsWith("commodity:") ? "COMMODITY_FUND" as const : "SECTOR_FUND" as const, session: true, source: SECTOR_QUOTES_SOURCE })) : [])
  ];
  const rows = descriptors.length
    ? await repo.pointsBetween(descriptors.map((d) => d.key), new Date(at.getTime() - CROSS_MARKET_HORIZON_HOURS * HOUR_MS).toISOString(), new Date(at.getTime() + 1).toISOString())
    : [];
  const points = new Map<string, SourcedPoint[]>();
  for (const row of rows) {
    const list = points.get(row.series_key) ?? [];
    list.push({ eventTime: new Date(row.event_time).toISOString(), value: Number(row.value), source: row.source });
    points.set(row.series_key, list);
  }
  return buildCrossMarketView({
    at,
    series: descriptors.map(({ source, ...d }) => ({ ...d, points: (points.get(d.key) ?? []).filter((p) => !source || p.source === source) }))
  });
}

/**
 * D15 read APIs: Narrative Radar, Anomaly Detection, the Signal Engine and
 * Cross-Market Intelligence. See docs/milestone-d15-market-intelligence-engines.md.
 *
 * Every route reads the observation ledger or stored signal captures. None
 * calls a provider, and none writes: anomaly captures are written by the
 * worker and by nothing else.
 */
export function registerMarketIntelligence(deps: MarketIntelligenceDeps): void {
  const { app, config, sql } = deps;
  const now = deps.now ?? (() => new Date());
  const repo = createObservationRepo(sql);
  const rate = { rateLimit: { max: config.REWIND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } };

  async function admit(enabled: boolean, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (!enabled) { reply.code(403).send({ code: "FEATURE_DISABLED" }); return false; }
    const user = await deps.requireUser(req, reply);
    if (!user) return false;
    if (user.isAnonymous) { reply.code(401).send({ code: "UNAUTHENTICATED" }); return false; }
    return true;
  }

  // ---- Narrative Radar ----
  app.get("/v1/narratives", { config: rate }, async (req, reply) => {
    if (!(await admit(config.ENABLE_NARRATIVE_RADAR, req, reply))) return;
    const at = now();
    const before = new Date(at.getTime() + 1).toISOString();
    const [radar, stored] = await Promise.all([
      loadNarrativeRadar(repo, at),
      repo.latestSignalledCaptures(["NARRATIVE", "ANOMALY"], new Date(at.getTime() - NARRATIVE_SIGNALS_DAYS * 24 * HOUR_MS).toISOString(), before, FEED_CAPTURES_LIMIT).then(currentAnomalies)
    ]);
    const signalsFor = (topic: string) => stored
      .filter((row) => (row.domain === "NARRATIVE" && row.subject === topic) || (row.domain === "ANOMALY" && row.subject === narrativeContextSeriesKey(topic)))
      .slice(0, 10)
      .flatMap((row) => signalsOf(row).map((signal) => ({ observedAt: new Date(row.observed_at).toISOString(), domain: row.domain, ...signal })));
    return {
      engineVersion: NARRATIVE_RADAR_VERSION,
      asOf: at.toISOString(),
      recentHours: NARRATIVE_RECENT_HOURS,
      baselineHours: NARRATIVE_BASELINE_HOURS,
      capture: { mentions: config.ENABLE_NARRATIVE_CONTEXT_CAPTURE, signals: config.ENABLE_CONTEXT_SIGNAL_CAPTURE, anomalies: config.ENABLE_ANOMALY_CAPTURE },
      topics: radar.map((entry) => ({ ...entry, storedSignals: signalsFor(entry.topic) })),
      limitations: [
        "A topic's count is the distinct articles GDELT's Context index saw mentioning it in an hour. It measures how much was published: not sentiment, not social media, and not whether the coverage was accurate.",
        "An hour with no article and an hour that was not read are both absent from the record, and both are left out of the averages.",
        "The topic list is fixed. A topic is not added because a story is already trending, so a story outside the list does not appear here at all.",
        "The index searches a subset of the news GDELT monitors and keeps 72 hours, so an hour not read in time is gone.",
        "The state shown is measured now, from the counts on record. Signals listed under a topic are the ones stored at capture time; those do not change."
      ]
    };
  });

  // ---- Anomaly Detection ----
  app.get<{ Querystring: { hours?: string } }>("/v1/anomalies", { config: rate }, async (req, reply) => {
    if (!(await admit(config.ENABLE_ANOMALY_DETECTION, req, reply))) return;
    const at = now();
    const windowHours = hoursParam(req.query.hours, 72, 720);
    const from = new Date(at.getTime() - windowHours * HOUR_MS).toISOString();
    const before = new Date(at.getTime() + 1).toISOString();
    const [rows, coverage] = await Promise.all([
      repo.latestSignalledCaptures(["ANOMALY"], from, before, ANOMALIES_LIMIT).then(currentAnomalies),
      repo.captureCoverage(["ANOMALY"], from, before)
    ]);
    return {
      engineVersion: ANOMALY_ENGINE_VERSION,
      asOf: at.toISOString(),
      windowHours,
      rule: { baselineHours: ANOMALY_BASELINE_HOURS, minBaselineChanges: ANOMALY_MIN_BASELINE_CHANGES, threshold: ANOMALY_Z_THRESHOLD },
      capture: config.ENABLE_ANOMALY_CAPTURE,
      coverage: coverageView(coverage, "ANOMALY"),
      truncated: rows.length === ANOMALIES_LIMIT,
      anomalies: rows.flatMap((row) => signalsOf(row).map((signal) => ({
        id: row.id, series: row.subject, ...resolveSubject("ANOMALY", row.subject), observedAt: new Date(row.observed_at).toISOString(),
        qualityGrade: row.quality_grade, ...signal
      }))),
      limitations: [
        "An anomaly is an hourly change far outside the same series' changes of the two weeks before. It is a measurement of size, not a cause, a forecast or advice.",
        "Each reading was made once, when the hour was first seen, and stored. Nothing here is recomputed, so the record begins when the capture was switched on.",
        "Only readings of the engine version named here are listed. Readings an earlier version stored are kept and counted in the coverage, and are not shown as anomalies.",
        "A series is read only when it has a change in consecutive hours from one source: a gap in the ledger is a gap here, and a series with fewer than 96 hourly changes on record is not measured.",
        "Series priced only in the US session (options, sector and commodity funds), token supply and the share-of-news reading are not read by this version.",
        "A tokenized stock's price is the token's price in one on-chain pool. One large swap can be an anomaly without the underlying equity moving.",
        "A window with no anomaly listed is the usual result. A window with no capture at all means nobody was looking, which the coverage counts show."
      ]
    };
  });

  // ---- Signal Engine ----
  app.get<{ Querystring: { hours?: string } }>("/v1/signals", { config: rate }, async (req, reply) => {
    if (!(await admit(config.ENABLE_SIGNAL_ENGINE, req, reply))) return;
    const at = now();
    const windowHours = hoursParam(req.query.hours, 24, 168);
    const from = new Date(at.getTime() - windowHours * HOUR_MS).toISOString();
    const before = new Date(at.getTime() + 1).toISOString();
    const domains: CaptureDomain[] = ["MARKET", "NARRATIVE", "SECTOR", "ANOMALY"];
    const [rows, coverage] = await Promise.all([
      repo.latestSignalledCaptures(domains, from, before, FEED_CAPTURES_LIMIT).then(currentAnomalies),
      repo.captureCoverage(domains, from, before)
    ]);
    const feed = buildSignalFeed({
      captures: rows.map((row) => ({ id: row.id, domain: row.domain, subject: row.subject, observedAt: new Date(row.observed_at).toISOString(), signals: signalsOf(row) })),
      resolve: resolveSubject
    });
    return {
      ...feed,
      asOf: at.toISOString(),
      windowHours,
      rule: { confluenceWindowHours: CONFLUENCE_WINDOW_HOURS, confluenceMinClasses: CONFLUENCE_MIN_CLASSES },
      // The oldest captures of the window are the ones left out when it is cut.
      truncated: rows.length === FEED_CAPTURES_LIMIT,
      coverage: domains.map((domain) => coverageView(coverage, domain)),
      limitations: [
        "Every signal here was computed and stored by the engine of its own domain, at capture time. This view runs no engine and changes no signal; it puts them on one timeline.",
        "A confluence means signals of at least three market classes were stored within six hours of each other. It claims no link between them: classes that share a trading day move in the same hours for unrelated reasons.",
        "A domain with no capture in the window was not being looked at. The coverage counts say which domains were captured, and how often.",
        "Sector and commodity fund signals come from an exchange's delayed public website feed that carries no redistribution licence, and exist only for hours of the US session.",
        "None of this is a prediction or advice, and no signal identifies a participant, an owner or an intent."
      ]
    };
  });

  // ---- Cross-Market Intelligence ----
  app.get("/v1/cross-market", { config: rate }, async (req, reply) => {
    if (!(await admit(config.ENABLE_CROSS_MARKET, req, reply))) return;
    return {
      ...(await loadCrossMarketView(repo, config, now())),
      capture: { crypto: config.ENABLE_REWIND_CAPTURE && config.ENABLE_MARKETS, tokenizedStocks: config.ENABLE_TOKENIZED_STOCK_CAPTURE, funds: config.ENABLE_SECTOR_CAPTURE },
      limitations: [
        "Everything here is measured on prices AEGIX already stored. A class is the members AEGIX captures, listed under it, not the market it is named after.",
        "A tokenized stock's price is the token's price in one on-chain pool. It follows the underlying equity only as far as arbitrage holds it there, and it trades while the stock market is closed.",
        "Fund prices come from an exchange's delayed public website feed that carries no redistribution licence. A fund's price is not the price of what it holds: a futures fund loses to the roll, and a miners' fund is shares of companies.",
        "A fund's return is today's last read price against the previous session's last read price, and exists only once the fund has traded today. The other classes are measured over the last 24 hours, so the two are not the same day.",
        "A correlation is between the classes' mean hourly log-changes over the last week. It describes that week. It is not a tested relationship, is not corrected for the number of pairs looked at, and says nothing about the next week; the Discovery Engine is what tests relationships.",
        "Nothing here is a prediction or advice."
      ]
    };
  });
}
