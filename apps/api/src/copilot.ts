/**
 * AI Intelligence Copilot (D16), see docs/milestone-d16-ai-copilot.md.
 *
 * One question over what AEGIX has on record across its products: stored
 * signals, anomalies, confluences, discoveries, news coverage and the
 * cross-market view, and one wallet's analysis when the caller names it.
 *
 * It is Ask AEGIX with a wider evidence block and nothing else. The model
 * decides no fact: every item it is shown was produced by a deterministic
 * engine, every statement it returns must cite one, and a citation of an ID
 * AEGIX did not supply is removed before a caller sees it.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { WalletContextProfile } from "@aegix/context";
import { isValidSolanaAddress } from "@aegix/blockchain";
import { createDiscoveryRepo, createObservationRepo, type CaptureDomain, type DiscoveryRow, type Sql } from "@aegix/database";
import {
  AIError, COPILOT_ENGINE_VERSION, COPILOT_SYSTEM_PROMPT, buildBoundedContext, enforceGrounding, generateWithRetry, sanitizeQuestion,
  type AIProvider, type EvidenceItem
} from "@aegix/ai";
import { buildSignalFeed, type CrossMarketView, type NarrativeRadarEntry, type SignalFeed } from "@aegix/sources";
import { profileToEvidence } from "./ask-aegix.js";
import { discoveryDisplayId } from "./discovery.js";
import { currentAnomalies, loadCrossMarketView, loadNarrativeRadar, resolveSubject } from "./market-intelligence.js";

export interface CopilotDeps {
  app: FastifyInstance;
  sql: Sql;
  config: AppConfig;
  logger: { info(msg: string, context?: Record<string, unknown>): void; warn(msg: string, context?: Record<string, unknown>): void };
  provider: AIProvider;
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<{ id: string; isAnonymous: boolean } | null>;
  claimQuota(userId: string): Promise<{ allowed: boolean; used: number; limit: number; resetAt: string }>;
  loadWalletContext(address: string): Promise<WalletContextProfile | null>;
  now?: () => Date;
}

const HOUR_MS = 3_600_000;
/** Stored signals are read over the last day: the question is about now. */
export const COPILOT_SIGNAL_HOURS = 24;
const COPILOT_CAPTURES_LIMIT = 2000;
const COPILOT_DISCOVERIES = 10;
/** More items than Ask AEGIX is given, because the record spans several products. */
const COPILOT_CONTEXT_BOUNDS = { maxItems: 60, maxChars: 20_000 };
/**
 * How many items of each product are kept whatever else outranks them, by ID
 * prefix. Ranked on severity alone, a day's market signals fill the block and
 * a question about news coverage or the cross-market view finds nothing to cite.
 */
const COPILOT_RESERVED: ReadonlyArray<readonly [prefix: string, count: number]> = [
  ["cov:", 1], ["ind:narrative:", 8], ["ind:cross:", 8], ["sig:discovery:", 5], ["sig:anomaly:", 5], ["ind:confluence:", 3]
];

/** The IDs kept ahead of the general ranking: each product's own highest-ranked items. */
export function reservedEvidence(items: readonly EvidenceItem[]): Set<string> {
  const reserved = new Set<string>();
  for (const [prefix, count] of COPILOT_RESERVED) {
    items.filter((item) => item.id.startsWith(prefix))
      .sort((a, b) => b.severity * b.confidence - a.severity * a.confidence || a.id.localeCompare(b.id))
      .slice(0, count).forEach((item) => reserved.add(item.id));
  }
  return reserved;
}

/** An evidence ID may hold letters, digits and a few marks; anything else in a subject becomes a dash. */
const idPart = (value: string) => value.replace(/[^A-Za-z0-9_.\-]/g, "-");

export interface CopilotRecord {
  feed: SignalFeed | null;
  radar: NarrativeRadarEntry[] | null;
  crossMarket: CrossMarketView | null;
  discoveries: DiscoveryRow[] | null;
  /** Captures stored in the signal window, per domain, including the ones that found nothing. */
  coverage: Array<{ domain: string; captures: number; signalled: number }>;
}

/**
 * Turns the record into citable evidence. Every item is text a deterministic
 * engine already produced, with the ID the model must cite.
 */
export function recordToEvidence(record: CopilotRecord): EvidenceItem[] {
  const items: EvidenceItem[] = [];

  for (const entry of record.feed?.entries ?? []) {
    items.push({
      id: `sig:${entry.domain.toLowerCase()}:${idPart(entry.subject)}:${idPart(entry.signalType)}`,
      label: entry.title,
      detail: `${entry.summary} Subject ${entry.label}; market class ${entry.marketClass}; stored in ${entry.captures} capture(s) from ${entry.firstObservedAt} to ${entry.lastObservedAt}.`,
      severity: entry.peakSeverity, confidence: 0.9
    });
  }
  (record.feed?.confluences ?? []).forEach((confluence, index) => {
    items.push({
      id: `ind:confluence:${index + 1}`,
      label: `Signals of ${confluence.classes.length} market classes stored within six hours`,
      detail: `From ${confluence.from} to ${confluence.to}: ${confluence.subjects.map((s) => `${s.label} (${s.marketClass}: ${s.signalTypes.join(", ")})`).join("; ")}. Signals coincided in time; no link between them is claimed or tested.`,
      severity: 70, confidence: 0.7
    });
  });

  for (const row of record.discoveries ?? []) {
    const card = row.card as { title?: string; summary?: string; confidence?: number; qValue?: number; hypothesesTested?: number } | null;
    items.push({
      id: `sig:discovery:${discoveryDisplayId(row.id)}`,
      label: card?.title ?? `${row.series_a} and ${row.series_b}`,
      detail: `${card?.summary ?? ""} Discovery ${discoveryDisplayId(row.id)}, status ${row.status}, first detected ${new Date(row.detected_at).toISOString()}; lag ${row.lag_hours}h, ${row.direction}; q ${card?.qValue ?? "unknown"} across ${card?.hypothesesTested ?? "unknown"} hypotheses; engine ${row.engine_version}. A statistical relationship between two series, not causation.`,
      severity: row.status === "CONFIRMED" ? 75 : row.status === "CANDIDATE" ? 55 : 20,
      confidence: typeof card?.confidence === "number" ? Math.max(0, Math.min(1, card.confidence)) : 0.5
    });
  }

  for (const topic of record.radar ?? []) {
    if (topic.state === "INSUFFICIENT_DATA") continue;
    items.push({
      id: `ind:narrative:${idPart(topic.topic)}`,
      label: `${topic.label} news coverage: ${topic.state.toLowerCase()}`,
      detail: `${topic.recentMean} articles an hour over the newest ${topic.recentHours} read hours, against ${topic.baselineMean} an hour over the ${topic.baselineHours} before${topic.ratio === null ? "" : `, ratio ${topic.ratio}`}. Newest hour on record ${topic.latestHour}. Article counts only: not sentiment, not social media.`,
      severity: topic.state === "ACCELERATING" ? 60 : topic.state === "FADING" ? 40 : 15, confidence: 0.8
    });
  }

  for (const group of record.crossMarket?.classes ?? []) {
    if (group.median24hPercent === null) continue;
    items.push({
      id: `ind:cross:${group.marketClass}`,
      label: `${group.marketClass} on the day`,
      detail: `Median ${group.median24hPercent}% over ${group.session ? "the session against the previous one" : "24 hours"}; ${group.advancing} of ${group.measured} measured members up${group.median7dPercent === null ? "" : `; median ${group.median7dPercent}% over 7 days`}. Members: ${group.members.filter((m) => m.return24hPercent !== null).map((m) => `${m.symbol} ${m.return24hPercent}%`).join(", ")}.`,
      severity: Math.min(100, 20 + Math.round(Math.abs(group.median24hPercent) * 10)), confidence: 0.9
    });
  }
  (record.crossMarket?.readings ?? []).forEach((reading, index) => {
    items.push({ id: `ind:cross:reading:${index + 1}`, label: reading.title, detail: reading.summary, severity: 65, confidence: 0.9 });
  });
  for (const pair of record.crossMarket?.correlations ?? []) {
    if (pair.r === null) continue;
    items.push({
      id: `ind:cross:correlation:${pair.a}:${pair.b}`,
      label: `${pair.a} and ${pair.b} over the week`,
      detail: `Pearson r ${pair.r} between the classes' mean hourly log-changes over ${pair.pairedHours} shared hours. Describes that week; not a tested relationship.`,
      severity: Math.round(Math.abs(pair.r) * 50), confidence: 0.7
    });
  }

  items.push({
    id: "cov:record",
    label: "What the record covers",
    detail: `Stored signals of the last ${COPILOT_SIGNAL_HOURS} hours: ${record.coverage.length ? record.coverage.map((c) => `${c.domain} ${c.captures} captures, ${c.signalled} with a signal`).join("; ") : "no capture in the window"}. `
      + `Discoveries ${record.discoveries === null ? "not read (switched off)" : `${record.discoveries.length} newest read`}; `
      + `news coverage ${record.radar === null ? "not read (switched off)" : "read"}; cross-market view ${record.crossMarket === null ? "not read (switched off)" : "read"}. `
      + "A product that was not read, or a window with no capture, is absence of record, not absence of activity.",
    severity: 100, confidence: 1
  });
  return items;
}

/** HTTP status for each way the AI layer can fail. */
const STATUS_FOR_CODE: Record<string, number> = { MISSING_CREDENTIAL: 503, RATE_LIMIT: 503, TIMEOUT: 504, TRUNCATED: 502, MALFORMED_RESPONSE: 502, PROVIDER_ERROR: 502 };

export function registerCopilot(deps: CopilotDeps): void {
  const { app, config, sql, logger, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const observations = createObservationRepo(sql);
  const discoveries = createDiscoveryRepo(sql);

  /** Reads each product's record only when that product is switched on. */
  async function loadRecord(at: Date): Promise<CopilotRecord> {
    const from = new Date(at.getTime() - COPILOT_SIGNAL_HOURS * HOUR_MS).toISOString();
    const before = new Date(at.getTime() + 1).toISOString();
    const domains: CaptureDomain[] = ["MARKET", "NARRATIVE", "SECTOR", "ANOMALY"];
    const [captures, coverage, radar, crossMarket, found] = await Promise.all([
      config.ENABLE_SIGNAL_ENGINE ? observations.latestSignalledCaptures(domains, from, before, COPILOT_CAPTURES_LIMIT).then(currentAnomalies) : null,
      config.ENABLE_SIGNAL_ENGINE ? observations.captureCoverage(domains, from, before) : [],
      config.ENABLE_NARRATIVE_RADAR ? loadNarrativeRadar(observations, at) : null,
      config.ENABLE_CROSS_MARKET ? loadCrossMarketView(observations, config, at) : null,
      config.ENABLE_DISCOVERY ? discoveries.list(COPILOT_DISCOVERIES) : null
    ]);
    return {
      feed: captures ? buildSignalFeed({
        resolve: resolveSubject,
        captures: captures.map((row) => ({
          id: row.id, domain: row.domain, subject: row.subject, observedAt: new Date(row.observed_at).toISOString(),
          signals: row.signals.map((s) => ({ type: s.type, severity: s.severity, confidence: s.confidence, title: s.title, summary: s.summary }))
        }))
      }) : null,
      radar, crossMarket, discoveries: found,
      coverage: coverage.map((row) => ({ domain: row.domain, captures: row.captures, signalled: row.signalled }))
    };
  }

  app.post<{ Body: { question: string; wallet?: string } }>("/v1/copilot/ask", {
    config: { rateLimit: { max: config.ASK_AEGIX_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } },
    schema: { body: { type: "object", additionalProperties: false, required: ["question"], properties: {
      question: { type: "string", minLength: 3, maxLength: 500 }, wallet: { type: "string", maxLength: 44 } } } }
  }, async (req, reply) => {
    const requestId = randomUUID();
    if (!config.ENABLE_AI_COPILOT) return reply.code(403).send({ code: "FEATURE_DISABLED", message: "The AI Intelligence Copilot is disabled", requestId });
    if (req.body.wallet && !isValidSolanaAddress(req.body.wallet)) return reply.code(400).send({ code: "INVALID_WALLET", requestId });
    const question = sanitizeQuestion(req.body.question);
    if (question.length < 3) return reply.code(400).send({ code: "INVALID_QUESTION", requestId });
    const user = await deps.requireUser(req, reply);
    if (!user) return;
    if (user.isAnonymous) return reply.code(401).send({ code: "UNAUTHENTICATED", requestId });
    // Reported before any provider work, and before the quota is spent, so a
    // caller can tell "not set up" from "the model failed".
    if (!provider.isConfigured()) return reply.code(503).send({ code: "AI_UNAVAILABLE", reason: "MISSING_CREDENTIAL", message: "No AI provider is configured", requestId });
    const quota = await deps.claimQuota(user.id);
    if (!quota.allowed) return reply.code(429).send({ code: "QUOTA_EXCEEDED", message: "Daily Ask AEGIX limit reached", ...quota, requestId });

    const [record, profile] = await Promise.all([loadRecord(now()), req.body.wallet ? deps.loadWalletContext(req.body.wallet) : null]);
    const evidence = recordToEvidence(record);
    if (profile) evidence.push(...profileToEvidence(profile));
    const context = buildBoundedContext(evidence, COPILOT_CONTEXT_BOUNDS, reservedEvidence(evidence));

    let generated;
    try {
      generated = await generateWithRetry(provider, {
        system: COPILOT_SYSTEM_PROMPT, question, evidenceBlock: context.block,
        model: config.LLM_MODEL, maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS, timeoutMs: config.AI_TIMEOUT_MS
      });
    } catch (error) {
      const reason = error instanceof AIError ? error.code : "PROVIDER_ERROR";
      logger.warn("copilot provider failure", { requestId, reason, model: config.LLM_MODEL });
      return reply.code(STATUS_FOR_CODE[reason] ?? 502).send({ code: "AI_UNAVAILABLE", reason, message: "The explanation service is unavailable", requestId });
    }

    const grounded = enforceGrounding(generated.answer, context.includedIds);
    grounded.answer.limitations.push(
      "The copilot restates what AEGIX's engines already stored or measured. It computes nothing, reads no chain and no market, and sees only the products switched on in this deployment.",
      "Signals that coincide in time are not shown to be linked, and nothing here is a prediction or advice.",
      ...(req.body.wallet && !profile ? ["The wallet named has no completed analysis, so nothing about it was available."] : []),
      ...(profile?.limitations ?? [])
    );
    logger.info("copilot answered", {
      requestId, model: generated.model, latencyMs: generated.latencyMs,
      promptTokens: generated.usage.promptTokens, completionTokens: generated.usage.completionTokens,
      evidenceOffered: context.includedIds.length, evidenceDropped: context.droppedCount,
      citationsDropped: grounded.droppedReferences, findingsDropped: grounded.droppedFindings
    });
    const included = new Set(context.includedIds);
    return {
      question,
      wallet: profile ? profile.wallet : null,
      answer: grounded.answer,
      // What each cited ID stands for, so a reader can check a statement against its source.
      evidence: evidence.filter((item) => included.has(item.id)).map((item) => ({ id: item.id, label: item.label })),
      evidenceOffered: context.includedIds,
      contextTruncated: context.truncated,
      contextDropped: context.droppedCount,
      citationsDropped: grounded.droppedReferences,
      findingsDropped: grounded.droppedFindings,
      sources: {
        signals: record.feed !== null, narratives: record.radar !== null, crossMarket: record.crossMarket !== null,
        discoveries: record.discoveries !== null, wallet: profile !== null
      },
      model: generated.model,
      engineVersion: COPILOT_ENGINE_VERSION,
      requestId,
      quota
    };
  });
}
