/**
 * Ask AEGIX (D9).
 *
 * The model explains what the deterministic engines already decided. It is
 * given a bounded, sanitised view of one analysis and asked to restate it
 * with citations; every citation is then checked against the evidence that
 * was actually supplied, and anything it invented is removed before a caller
 * sees it.
 *
 * Nothing in the analysis pipeline calls this. A provider outage costs the
 * product this endpoint and nothing else.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { Sql } from "@aegix/database";
import {
  AIError,
  ASK_AEGIX_SYSTEM_PROMPT,
  AI_ENGINE_VERSION,
  buildBoundedContext,
  enforceGrounding,
  generateWithRetry,
  sanitizeQuestion,
  type AIProvider,
  type EvidenceItem
} from "@aegix/ai";
import type { WalletContextProfile } from "@aegix/context";

export interface AskAegixDeps {
  app: FastifyInstance;
  sql: Sql;
  config: AppConfig;
  logger: { info: (msg: string, ctx?: Record<string, unknown>) => void; warn: (msg: string, ctx?: Record<string, unknown>) => void };
  provider: AIProvider;
  /** Loads the D8 profile for a wallet, or null when there is no analysis. */
  loadContext: (address: string) => Promise<WalletContextProfile | null>;
  requireUser: (req: never, reply: never) => Promise<{ id: string; isAnonymous: boolean } | null>;
  checkDailyQuota: (userId: string) => Promise<{ allowed: boolean; used: number; limit: number; resetAt: string }>;
  recordUsage: (userId: string, analysisId: string) => Promise<void>;
}

/** HTTP status for each way the AI layer can fail. */
const STATUS_FOR_CODE: Record<string, number> = {
  MISSING_CREDENTIAL: 503,
  RATE_LIMIT: 503,
  TIMEOUT: 504,
  TRUNCATED: 502,
  MALFORMED_RESPONSE: 502,
  PROVIDER_ERROR: 502
};

/**
 * Turns one context profile into citable evidence.
 *
 * Indicator descriptions are engine-written and trusted. Evidence values come
 * from chain data and are marked untrusted, so they are sanitised before they
 * reach the model.
 */
export function profileToEvidence(profile: WalletContextProfile): EvidenceItem[] {
  const items: EvidenceItem[] = profile.indicators.map((indicator) => ({
    id: indicator.id,
    label: indicator.title,
    detail: `${indicator.description} [${indicator.sourceEngine} ${indicator.engineVersion}] ${indicator.evidence
      .map((e) => `${e.label}=${String(e.value)}`)
      .join("; ")}`,
    severity: indicator.severity,
    confidence: indicator.confidence,
    untrusted: true
  }));

  for (const dimension of profile.dimensions) {
    items.push({
      id: dimension.id,
      label: dimension.label,
      detail: `Score dimension ${dimension.key} = ${dimension.score} of 100.`,
      severity: dimension.score,
      confidence: 1
    });
  }

  items.push({
    id: "cov:analysis",
    label: "Coverage",
    detail: `${profile.coverage.transactionsParsed} transactions parsed; dataset grade ${
      profile.coverage.grade ?? "unknown"
    }; sufficiency ${profile.sufficiency}; known-risk dataset ${profile.knownRisk.dataset}, result ${
      profile.knownRisk.match
    }.`,
    severity: 100,
    confidence: 1
  });

  return items;
}

export function registerAskAegix(deps: AskAegixDeps): void {
  const { app, config, logger, provider, loadContext, requireUser, checkDailyQuota, recordUsage } = deps;

  app.post<{ Params: { address: string }; Body: { question?: string } }>(
    "/v1/wallets/:address/ask",
    {
      config: {
        rateLimit: { max: config.ASK_AEGIX_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" }
      },
      schema: {
        body: {
          type: "object",
          required: ["question"],
          properties: { question: { type: "string", minLength: 3, maxLength: 500 } }
        }
      }
    },
    async (req, reply) => {
      const requestId = randomUUID();

      if (!config.ENABLE_ASK_AEGIX) {
        return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Ask AEGIX is disabled", requestId });
      }

      const user = await requireUser(req as never, reply as never);
      if (!user || user.isAnonymous) return;

      // Reported before any provider work, so a caller can tell "not set up"
      // from "the model failed".
      if (!provider.isConfigured()) {
        return reply
          .code(503)
          .send({ code: "AI_UNAVAILABLE", reason: "MISSING_CREDENTIAL", message: "No AI provider is configured", requestId });
      }

      const quota = await checkDailyQuota(user.id);
      if (!quota.allowed) {
        return reply.code(429).send({
          code: "QUOTA_EXCEEDED",
          message: "Daily Ask AEGIX limit reached",
          used: quota.used,
          limit: quota.limit,
          resetAt: quota.resetAt,
          requestId
        });
      }

      const profile = await loadContext(req.params.address);
      if (!profile) {
        return reply
          .code(404)
          .send({ code: "CHAIN_DATA_UNAVAILABLE", message: "No analysis available for this wallet", requestId });
      }

      const question = sanitizeQuestion(req.body.question ?? "");
      if (question.length < 3) {
        return reply.code(400).send({ code: "INVALID_QUESTION", message: "Question is empty after sanitisation", requestId });
      }

      const context = buildBoundedContext(profileToEvidence(profile));

      let generated;
      try {
        generated = await generateWithRetry(provider, {
          system: ASK_AEGIX_SYSTEM_PROMPT,
          question,
          evidenceBlock: context.block,
          model: config.LLM_MODEL,
          maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
          timeoutMs: config.AI_TIMEOUT_MS
        });
      } catch (err) {
        const code = err instanceof AIError ? err.code : "PROVIDER_ERROR";
        logger.warn("ask aegix provider failure", { requestId, aiErrorCode: code, model: config.LLM_MODEL });
        return reply
          .code(STATUS_FOR_CODE[code] ?? 502)
          .send({ code: "AI_UNAVAILABLE", reason: code, message: "The explanation service is unavailable", requestId });
      }

      const grounded = enforceGrounding(generated.answer, context.includedIds);

      try {
        await recordUsage(user.id, profile.analysisId);
      } catch {
        // Metering must not fail the answer it is measuring.
      }

      logger.info("ask aegix answered", {
          requestId,
          model: generated.model,
          latencyMs: generated.latencyMs,
          promptTokens: generated.usage.promptTokens,
          completionTokens: generated.usage.completionTokens,
          evidenceOffered: context.includedIds.length,
          evidenceDropped: context.droppedCount,
          citationsDropped: grounded.droppedReferences,
          findingsDropped: grounded.droppedFindings
      });

      return reply.send({
        wallet: profile.wallet,
        analysisId: profile.analysisId,
        question,
        answer: grounded.answer,
        evidenceOffered: context.includedIds,
        contextTruncated: context.truncated,
        contextDropped: context.droppedCount,
        citationsDropped: grounded.droppedReferences,
        findingsDropped: grounded.droppedFindings,
        model: generated.model,
        engineVersion: AI_ENGINE_VERSION,
        requestId
      });
    }
  );
}
