import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { WalletContextProfile } from "@aegix/context";
import { isValidSolanaAddress } from "@aegix/blockchain";
import { CANONICAL_ASSETS, MarketError, isCanonicalAsset, marketTemporalContext, type CanonicalAsset, type MarketSnapshot } from "@aegix/markets";
import { AIError, AI_ENGINE_VERSION, ASK_AEGIX_SYSTEM_PROMPT, buildBoundedContext, enforceGrounding, generateWithRetry, sanitizeQuestion, type AIProvider, type EvidenceItem } from "@aegix/ai";
import { profileToEvidence } from "./ask-aegix.js";

export interface MarketsDeps {
  app: FastifyInstance;
  config: AppConfig;
  service: { getSnapshot(asset: CanonicalAsset): Promise<MarketSnapshot> };
  provider: AIProvider;
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<{ id: string; isAnonymous: boolean } | null>;
  claimQuota(userId: string, ai: boolean): Promise<{ allowed: boolean; used: number; limit: number; resetAt: string }>;
  loadWalletContext(address: string): Promise<WalletContextProfile | null>;
  logger: { info(msg: string, context?: Record<string, unknown>): void; warn(msg: string, context?: Record<string, unknown>): void };
}

export function marketToEvidence(snapshot: MarketSnapshot): EvidenceItem[] {
  const { quote, history } = snapshot;
  const items: EvidenceItem[] = [{ id: `cov:market:${quote.asset}:quote`, label: `${quote.asset} market quote`,
    detail: quote.freshness.status === "UNAVAILABLE" ? "No current usable price observation."
      : `USD price ${quote.priceUsd}; rolling 24h USD volume ${quote.volume24hUsd ?? "unavailable"}; provider ${quote.provider}; timestamp ${quote.freshness.providerTimestamp}; freshness ${quote.freshness.status}; quality ${snapshot.quality.grade}.`,
    severity: 100, confidence: quote.freshness.status === "FRESH" ? 1 : 0.5 },
    { id: `cov:market:${quote.asset}:history`, label: "Bounded market history", severity: 100, confidence: 1,
      detail: `${history.length} hourly price observations, ${history[0]?.timestamp ?? "unknown"} to ${history.at(-1)?.timestamp ?? "unknown"}. ${snapshot.limitations.join(" ")}` }];
  for (const signal of snapshot.signals) items.push({ id: signal.id, label: signal.title,
    detail: `${signal.summary} ${signal.evidence.map((e) => `${e.key}=${e.value}`).join("; ")}; engine ${signal.engineVersion}`,
    severity: signal.severity, confidence: signal.confidence });
  return items;
}

export function registerMarkets(deps: MarketsDeps): void {
  const { app, config, service, provider, logger } = deps;
  const rate = { rateLimit: { max: config.MARKETS_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } };
  async function admit(req: FastifyRequest, reply: FastifyReply, ai: boolean) {
    if (!config.ENABLE_MARKETS || (ai && !config.ENABLE_ASK_AEGIX)) { reply.code(403).send({ code: "FEATURE_DISABLED" }); return null; }
    const user = await deps.requireUser(req, reply);
    if (!user) return null;
    if (user.isAnonymous) { reply.code(401).send({ code: "UNAUTHENTICATED" }); return null; }
    if (ai && !provider.isConfigured()) { reply.code(503).send({ code: "AI_UNAVAILABLE", reason: "MISSING_CREDENTIAL" }); return null; }
    const quota = await deps.claimQuota(user.id, ai);
    if (!quota.allowed) { reply.code(429).send({ code: "QUOTA_EXCEEDED", ...quota }); return null; }
    return quota;
  }
  async function contextualize(snapshot: MarketSnapshot, wallet?: string) {
    if (!wallet) return { snapshot, profile: null, temporalContext: [] as ReturnType<typeof marketTemporalContext> };
    const profile = await deps.loadWalletContext(wallet);
    const events = profile?.indicators.flatMap((indicator) => indicator.evidence.flatMap((e) =>
      typeof e.value === "string" && /time|date/i.test(e.key) && /^\d{4}-\d{2}-\d{2}T/.test(e.value)
        ? [{ evidenceId: indicator.id, timestamp: e.value }] : [])) ?? [];
    return { snapshot, profile, temporalContext: marketTemporalContext(snapshot, events),
      contextLimitations: ["Only timestamped evidence from the existing Solana analysis is matched. BTC and ETH are market identities, not additional on-chain pipelines."] };
  }
  function failed(error: unknown, reply: FastifyReply) {
    const code = error instanceof MarketError ? error.code : "PROVIDER_ERROR";
    return reply.code(503).send({ code: "MARKET_DATA_UNAVAILABLE", reason: code, requestId: randomUUID() });
  }
  app.get("/v1/markets", { config: rate }, async (req, reply) => {
    const quota = await admit(req, reply, false);
    if (!quota) return;
    const markets = await Promise.all(CANONICAL_ASSETS.map(async (asset) => {
      try { return { asset, status: "AVAILABLE", snapshot: await service.getSnapshot(asset) }; }
      catch { return { asset, status: "UNAVAILABLE", snapshot: null }; }
    }));
    return { markets, quota };
  });
  app.get<{ Params: { asset: string }; Querystring: { wallet?: string } }>("/v1/markets/:asset", { config: rate }, async (req, reply) => {
    if (!isCanonicalAsset(req.params.asset)) return reply.code(400).send({ code: "UNKNOWN_ASSET" });
    if (req.query.wallet && !isValidSolanaAddress(req.query.wallet)) return reply.code(400).send({ code: "INVALID_WALLET" });
    const quota = await admit(req, reply, false);
    if (!quota) return;
    try {
      const result = await contextualize(await service.getSnapshot(req.params.asset), req.query.wallet);
      return { asset: req.params.asset, snapshot: result.snapshot, temporalContext: result.temporalContext, contextLimitations: result.contextLimitations, quota };
    } catch (error) { return failed(error, reply); }
  });
  app.post<{ Params: { asset: string }; Body: { question: string; wallet?: string } }>("/v1/markets/:asset/ask", {
    config: { rateLimit: { max: config.ASK_AEGIX_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["question"], properties: {
      question: { type: "string", minLength: 3, maxLength: 500 }, wallet: { type: "string", maxLength: 44 } } } }
  }, async (req, reply) => {
    if (!isCanonicalAsset(req.params.asset)) return reply.code(400).send({ code: "UNKNOWN_ASSET" });
    if (req.body.wallet && !isValidSolanaAddress(req.body.wallet)) return reply.code(400).send({ code: "INVALID_WALLET" });
    const question = sanitizeQuestion(req.body.question);
    if (question.length < 3) return reply.code(400).send({ code: "INVALID_QUESTION" });
    const quota = await admit(req, reply, true);
    if (!quota) return;
    let result;
    try { result = await contextualize(await service.getSnapshot(req.params.asset), req.body.wallet); }
    catch (error) { return failed(error, reply); }
    const evidence = marketToEvidence(result.snapshot);
    if (result.profile) evidence.push(...profileToEvidence(result.profile));
    for (const temporal of result.temporalContext) evidence.push({ id: temporal.id, label: "Temporal proximity",
      detail: `${temporal.onChainTimestamp} and ${temporal.marketTimestamp}; offset ${temporal.offsetSeconds}s. ${temporal.note}`, severity: 30, confidence: 0.6 });
    const context = buildBoundedContext(evidence);
    const requestId = randomUUID();
    try {
      const generated = await generateWithRetry(provider, { system: ASK_AEGIX_SYSTEM_PROMPT, question, evidenceBlock: context.block,
        model: config.LLM_MODEL, maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS, timeoutMs: config.AI_TIMEOUT_MS });
      const grounded = enforceGrounding(generated.answer, context.includedIds);
      grounded.answer.limitations.push(...result.snapshot.limitations, ...(result.profile?.limitations ?? []));
      logger.info("market explanation metered", { requestId, model: generated.model, latencyMs: generated.latencyMs,
        promptTokens: generated.usage.promptTokens, completionTokens: generated.usage.completionTokens,
        citationsDropped: grounded.droppedReferences, findingsDropped: grounded.droppedFindings });
      return { asset: req.params.asset, question, answer: grounded.answer, evidenceOffered: context.includedIds,
        contextTruncated: context.truncated, contextDropped: context.droppedCount,
        citationsDropped: grounded.droppedReferences, findingsDropped: grounded.droppedFindings,
        model: generated.model, engineVersion: AI_ENGINE_VERSION, requestId, quota };
    } catch (error) {
      const reason = error instanceof AIError ? error.code : "PROVIDER_ERROR";
      logger.warn("market explanation unavailable", { requestId, reason });
      return reply.code(503).send({ code: "AI_UNAVAILABLE", reason, requestId });
    }
  });
}
