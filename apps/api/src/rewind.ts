import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import { isValidSolanaAddress } from "@aegix/blockchain";
import { createDiscoveryRepo, createObservationRepo, type DiscoveryRow, type Sql, type StoredCaptureRow } from "@aegix/database";
import { CANONICAL_ASSETS, isCanonicalAsset } from "@aegix/markets";
import { NARRATIVE_TOPICS, QUOTED_FUNDS, TOKENIZED_STOCKS, isTokenizedStockSymbol, tokenizedStockSeriesKey } from "@aegix/sources";
import {
  buildReplay, marketSeriesKey, MARKET_METRICS, replayWindow, RewindError, REWIND_DEFAULT_LOOKBACK_HOURS, REWIND_MAX_LOOKBACK_HOURS, REWIND_MIN_LOOKBACK_HOURS,
  type CaptureRecord, type KnownDiscovery
} from "@aegix/rewind";
import { discoveryDisplayId } from "./discovery.js";
import { reconstructReplay } from "./rewind-reconstruction.js";

export interface RewindDeps {
  app: FastifyInstance;
  config: AppConfig;
  sql: Sql;
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<{ id: string; isAnonymous: boolean } | null>;
  now?: () => Date;
}

function toCapture(row: StoredCaptureRow): CaptureRecord {
  return {
    id: row.id,
    observedAt: new Date(row.observed_at).toISOString(),
    engineVersion: row.engine_version,
    qualityGrade: row.quality_grade,
    providerStatus: row.provider_status,
    signals: row.signals.map((s) => ({ ...s, evidence: Array.isArray(s.evidence) ? s.evidence : [] }))
  };
}

const KNOWN_DISCOVERIES_LIMIT = 50;
/** Context captures read for one replay; a 720-hour window of every topic and fund stays under it. */
const CONTEXT_CAPTURES_LIMIT = 5000;

/** What a context capture's subject is, in words. */
function contextLabel(domain: string, subject: string): string {
  if (domain === "NARRATIVE") return `${NARRATIVE_TOPICS.find((topic) => topic.id === subject)?.label ?? subject} news coverage`;
  const fund = QUOTED_FUNDS.find((f) => f.symbol === subject);
  return fund ? `${fund.symbol} fund (${fund.holds})` : subject;
}

/** The ledger series that belong to a replayable asset. */
function subjectSeriesKeys(subject: string): string[] {
  return isTokenizedStockSymbol(subject)
    ? [tokenizedStockSeriesKey(subject, "price_usdc"), tokenizedStockSeriesKey(subject, "supply")]
    : MARKET_METRICS.map((metric) => marketSeriesKey(subject, metric));
}

function toKnownDiscovery(row: DiscoveryRow): KnownDiscovery {
  const title = (row.card as { title?: unknown } | null)?.title;
  return {
    id: discoveryDisplayId(row.id),
    detectedAt: new Date(row.detected_at).toISOString(),
    status: row.status,
    title: typeof title === "string" ? title : `${row.series_a} and ${row.series_b}`,
    seriesA: row.series_a,
    seriesB: row.series_b,
    lagHours: row.lag_hours,
    direction: row.direction,
    engineVersion: row.engine_version
  };
}

/**
 * AEGIX Rewind (D14), see docs/milestone-d14-rewind-discovery.md.
 *
 * A replay reads stored captures and nothing else. It never calls a market
 * provider, an RPC or an engine: anything fetched or computed now would be
 * hindsight by construction.
 */
export function registerRewind(deps: RewindDeps): void {
  const { app, config, sql } = deps;
  const now = deps.now ?? (() => new Date());
  const repo = createObservationRepo(sql);
  const discoveryRepo = createDiscoveryRepo(sql);

  // What can be replayed. Listed from the registries, not from the ledger: a
  // subject with no capture yet is still a valid question with a NO_COVERAGE answer.
  app.get("/v1/rewind/subjects", { config: { rateLimit: { max: config.REWIND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } }, async (_req, reply) => {
    if (!config.ENABLE_REWIND) return reply.code(403).send({ code: "FEATURE_DISABLED" });
    return {
      assets: [
        ...CANONICAL_ASSETS.map((asset) => ({ subject: asset as string, label: asset as string, kind: "MARKET_ASSET" })),
        ...TOKENIZED_STOCKS.filter((s) => s.pool).map((s) => ({ subject: s.symbol, label: `${s.symbol} — ${s.underlying} (tokenized, on-chain price)`, kind: "TOKENIZED_STOCK" }))
      ],
      topics: NARRATIVE_TOPICS.map((topic) => ({ subject: topic.id, label: `${topic.label} — news coverage`, kind: "NEWS_TOPIC" })),
      funds: QUOTED_FUNDS.map((fund) => ({ subject: fund.symbol, label: `${fund.symbol} — fund holding ${fund.holds}`, kind: "FUND" }))
    };
  });

  app.post<{ Body: { subjectType: "asset" | "wallet" | "narrative" | "sector"; subject: string; eventTime: string; lookbackHours?: number } }>("/v1/rewind", {
    config: { rateLimit: { max: config.REWIND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["subjectType", "subject", "eventTime"], properties: {
      subjectType: { type: "string", enum: ["asset", "wallet", "narrative", "sector"] },
      subject: { type: "string", minLength: 1, maxLength: 44 },
      eventTime: { type: "string", maxLength: 40 },
      lookbackHours: { type: "number", minimum: REWIND_MIN_LOOKBACK_HOURS, maximum: REWIND_MAX_LOOKBACK_HOURS } } } }
  }, async (req, reply) => {
    if (!config.ENABLE_REWIND) return reply.code(403).send({ code: "FEATURE_DISABLED" });
    const user = await deps.requireUser(req, reply);
    if (!user) return;
    if (user.isAnonymous) return reply.code(401).send({ code: "UNAUTHENTICATED" });

    const { subjectType, subject, eventTime } = req.body;
    const lookbackHours = req.body.lookbackHours ?? REWIND_DEFAULT_LOOKBACK_HOURS;
    if (subjectType === "asset" && !isCanonicalAsset(subject) && !isTokenizedStockSymbol(subject)) return reply.code(400).send({ code: "UNKNOWN_ASSET", message: "This asset cannot be replayed" });
    if (subjectType === "wallet" && !isValidSolanaAddress(subject)) return reply.code(400).send({ code: "INVALID_WALLET", message: "Invalid Solana wallet address" });
    if (subjectType === "narrative" && !NARRATIVE_TOPICS.some((topic) => topic.id === subject)) return reply.code(400).send({ code: "UNKNOWN_TOPIC", message: "This news topic cannot be replayed" });
    if (subjectType === "sector" && !QUOTED_FUNDS.some((fund) => fund.symbol === subject)) return reply.code(400).send({ code: "UNKNOWN_FUND", message: "This fund cannot be replayed" });

    const requestedAt = now().toISOString();
    try {
      const { start, lock } = replayWindow(eventTime, lookbackHours, requestedAt);
      const rows = subjectType === "wallet"
        ? await repo.walletCapturesBetween("solana", subject, start.toISOString(), lock.toISOString())
        : await repo.capturesBetween(subjectType === "narrative" ? "NARRATIVE" : subjectType === "sector" ? "SECTOR" : "MARKET", subject, start.toISOString(), lock.toISOString());
      // What news coverage and the funds were doing around an asset, as
      // stored then. Captures that held a signal only: a quiet capture of a
      // topic says nothing about the asset.
      const around = subjectType === "asset"
        ? await repo.signalledCapturesBetween(["NARRATIVE", "SECTOR"], start.toISOString(), lock.toISOString(), CONTEXT_CAPTURES_LIMIT)
        : [];
      // Relationships the Discovery Engine had already stamped on this
      // subject's series. Read under the same lock, and only when that
      // product is on; a wallet has no series in the ledger.
      const known = subjectType === "asset" && config.ENABLE_DISCOVERY
        ? await discoveryRepo.knownBefore(subjectSeriesKeys(subject), lock.toISOString(), KNOWN_DISCOVERIES_LIMIT)
        : [];
      const replay = buildReplay({
        subject, eventTime, lookbackHours, requestedAt, captures: rows.map(toCapture), discoveries: known.map(toKnownDiscovery),
        context: around.map((row) => ({ ...toCapture(row), domain: row.domain, subject: row.subject, label: contextLabel(row.domain, row.subject) }))
      });
      if (subjectType === "narrative") {
        replay.limitations.push(
          "A news topic's signals are measured on the number of articles GDELT's Context index saw mentioning it, per hour. That is how much was published, not sentiment, not social media, and not whether the coverage was accurate.",
          "An hour with no article and an hour that was not read are both absent from the record, so both are left out of the averages.",
          "A topic has one signal type, so no capture can hold three: the answer can be a signal observed, never a convergence."
        );
      }
      if (subjectType === "sector") {
        replay.limitations.push(
          "A fund's signals are measured on its delayed price from the exchange's public website feed, read once an hour while the US market is open. Nothing is captured outside the session.",
          "A fund's price is not the price of what it holds: a futures fund loses to the roll, and a miners' fund is shares of companies.",
          "A fund has at most two signal types, so no capture can hold three: the answer can be a signal observed, never a convergence."
        );
      }
      if (subjectType === "asset" && isTokenizedStockSymbol(subject)) {
        replay.limitations.push(
          "Signals for a tokenized stock are measured on the token's price in one on-chain pool. That price can differ from the underlying equity, and it trades while the stock market is closed.",
          "On-chain volume is not captured for tokenized stocks, so no volume signal can appear."
        );
      }
      if (subjectType === "wallet") {
        replay.limitations.push(
          "Wallet captures are completed analyses. An analysis exists only when someone requested it or a monitor ran, so coverage is irregular.",
          "Each analysis covers a bounded history window ending when it ran, not the wallet's full history."
        );
      }
      // The hours of the window with no stored capture, run through the
      // engine now. A separate object beside the replay, behind its own flag.
      if (config.ENABLE_REWIND_RECONSTRUCTION && subjectType === "asset") {
        const reconstruction = await reconstructReplay({
          repo, subject, eventTime, lookbackHours, requestedAt, windowStart: start, lock, firstCaptureAt: replay.coverage.firstCaptureAt
        });
        return { subjectType, ...replay, reconstruction };
      }
      return { subjectType, ...replay };
    } catch (error) {
      if (error instanceof RewindError) return reply.code(400).send({ code: error.code, message: error.message });
      throw error;
    }
  });
}
