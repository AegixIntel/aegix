import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import { isValidSolanaAddress } from "@aegix/blockchain";
import { createObservationRepo, type Sql, type StoredCaptureRow } from "@aegix/database";
import { CANONICAL_ASSETS, isCanonicalAsset } from "@aegix/markets";
import { TOKENIZED_STOCKS, isTokenizedStockSymbol } from "@aegix/sources";
import {
  buildReplay, replayWindow, RewindError, REWIND_DEFAULT_LOOKBACK_HOURS, REWIND_MAX_LOOKBACK_HOURS, REWIND_MIN_LOOKBACK_HOURS,
  type CaptureRecord
} from "@aegix/rewind";

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

/**
 * AEGIX Rewind (D14), see docs/milestone-d14-rewind-discovery.md.
 *
 * The route reads stored captures and nothing else. It never calls a market
 * provider, an RPC or an engine: anything fetched or computed now would be
 * hindsight by construction.
 */
export function registerRewind(deps: RewindDeps): void {
  const { app, config, sql } = deps;
  const now = deps.now ?? (() => new Date());
  const repo = createObservationRepo(sql);

  // What can be replayed. Listed from the registries, not from the ledger: a
  // subject with no capture yet is still a valid question with a NO_COVERAGE answer.
  app.get("/v1/rewind/subjects", { config: { rateLimit: { max: config.REWIND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } }, async (_req, reply) => {
    if (!config.ENABLE_REWIND) return reply.code(403).send({ code: "FEATURE_DISABLED" });
    return {
      assets: [
        ...CANONICAL_ASSETS.map((asset) => ({ subject: asset as string, label: asset as string, kind: "MARKET_ASSET" })),
        ...TOKENIZED_STOCKS.filter((s) => s.pool).map((s) => ({ subject: s.symbol, label: `${s.symbol} — ${s.underlying} (tokenized, on-chain price)`, kind: "TOKENIZED_STOCK" }))
      ]
    };
  });

  app.post<{ Body: { subjectType: "asset" | "wallet"; subject: string; eventTime: string; lookbackHours?: number } }>("/v1/rewind", {
    config: { rateLimit: { max: config.REWIND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["subjectType", "subject", "eventTime"], properties: {
      subjectType: { type: "string", enum: ["asset", "wallet"] },
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
    if (subjectType === "asset" && !isCanonicalAsset(subject) && !isTokenizedStockSymbol(subject)) return reply.code(400).send({ code: "UNKNOWN_ASSET" });
    if (subjectType === "wallet" && !isValidSolanaAddress(subject)) return reply.code(400).send({ code: "INVALID_WALLET" });

    const requestedAt = now().toISOString();
    try {
      const { start, lock } = replayWindow(eventTime, lookbackHours, requestedAt);
      const rows = subjectType === "asset"
        ? await repo.capturesBetween("MARKET", subject, start.toISOString(), lock.toISOString())
        : await repo.walletCapturesBetween("solana", subject, start.toISOString(), lock.toISOString());
      const replay = buildReplay({ subject, eventTime, lookbackHours, requestedAt, captures: rows.map(toCapture) });
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
      return { subjectType, ...replay };
    } catch (error) {
      if (error instanceof RewindError) return reply.code(400).send({ code: error.code, message: error.message });
      throw error;
    }
  });
}
