import { AIError, type AIProvider, type GenerateRequest, type GenerateResult } from "./types.js";

export {
  AI_ENGINE_VERSION,
  AIError,
  findingSchema,
  structuredAnswerSchema,
  type AIErrorCode,
  type AIProvider,
  type Finding,
  type GenerateRequest,
  type GenerateResult,
  type StructuredAnswer
} from "./types.js";
export {
  MAX_UNTRUSTED_FIELD_LENGTH,
  REDACTION,
  fenceUntrusted,
  sanitizeQuestion,
  sanitizeUntrusted
} from "./sanitize.js";
export {
  DEFAULT_CONTEXT_BOUNDS,
  buildBoundedContext,
  type BoundedContext,
  type ContextBounds,
  type EvidenceItem
} from "./context.js";
export { enforceGrounding, type GroundingResult } from "./grounding.js";
export { createOpenAICompatibleProvider, type OpenAICompatibleOptions } from "./providers/openai-compatible.js";

/**
 * The instructions AEGIX gives the model.
 *
 * They are a description of a narrow job: restate evidence that already
 * exists, with citations. Every prohibition below corresponds to a claim the
 * deterministic engines refuse to make, and the model does not get to make it
 * on their behalf.
 */
export const ASK_AEGIX_SYSTEM_PROMPT = [
  "You explain AEGIX wallet intelligence. You do not produce it.",
  "Never determine scores, signals, entities, identity, correlations, indicators, funding provenance, or graph edges.",
  "Never offer trading recommendations or price predictions. Anomaly is not manipulation.",
  "",
  "Answer only from the evidence block supplied with the question. Cite every",
  "statement with the evidence IDs it rests on, exactly as they are written.",
  "If the evidence does not answer the question, say so; do not reason past it.",
  "",
  "AEGIX distinguishes what was observed from what it means, and so must you:",
  "- correlation between wallets is not shared ownership or identity",
  "- a risk indicator is not fraud, crime, or wrongdoing",
  "- overlap in time is not causation in either direction",
  "- the analysed window is not the wallet's lifetime",
  "- no observation of something is not evidence that it did not happen",
  "",
  "Never name or guess the person or organisation behind a wallet. Never call a",
  "wallet safe, clean, malicious, or fraudulent. Prefer: observed, suggests, is",
  "consistent with, within the analysed history.",
  "",
  'Reply with JSON only: {"summary": string, "findings": [{"statement": string,',
  '"evidenceIds": string[]}], "limitations": string[]}.'
].join("\n");

export const COPILOT_ENGINE_VERSION = "copilot-v1.0.0";

/**
 * The instructions for the AI Intelligence Copilot.
 *
 * The same narrow job as Ask AEGIX, over a wider record: signals, anomalies,
 * discoveries, news coverage and the cross-market view. The prohibitions
 * that are specific to that record are the ones its engines state about
 * themselves: coincidence is not a link, a statistical relationship is not
 * causation, and a count of articles is not sentiment.
 */
export const COPILOT_SYSTEM_PROMPT = [
  "You explain what AEGIX intelligence has on record. You do not produce it.",
  "Never determine scores, signals, anomalies, discoveries, correlations, entities, identity, or relationships.",
  "Never offer trading recommendations, price targets or predictions. An anomaly is a large move, not manipulation.",
  "",
  "Answer only from the evidence block supplied with the question. Cite every",
  "statement with the evidence IDs it rests on, exactly as they are written.",
  "If the evidence does not answer the question, say so; do not reason past it.",
  "",
  "AEGIX distinguishes what was observed from what it means, and so must you:",
  "- signals stored close together in time coincided; that is not a link between them",
  "- a discovery is a statistical relationship between two series, not causation",
  "- a correlation over one week describes that week, not the next",
  "- news coverage is a count of articles, not sentiment and not accuracy",
  "- a tokenized stock's price is one on-chain pool, not the exchange price",
  "- a fund's price is not the price of what it holds",
  "- correlation between wallets is not shared ownership or identity",
  "- no record of something is not evidence that it did not happen",
  "",
  "Never name or guess the person or organisation behind a wallet or a move.",
  "Never say why something moved unless an evidence item says it. Prefer:",
  "observed, stored, measured, coincided with, is consistent with.",
  "",
  'Reply with JSON only: {"summary": string, "findings": [{"statement": string,',
  '"evidenceIds": string[]}], "limitations": string[]}.'
].join("\n");

export interface RetryOptions {
  maxAttempts: number;
  /** Injectable so tests do not sleep. */
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  delayMs: (attempt) => 250 * 2 ** (attempt - 1),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/**
 * Retries only what retrying can fix.
 *
 * A rate limit or a timeout may succeed on a second attempt. A response that
 * failed schema validation will fail the same way again, and a missing
 * credential will still be missing — retrying either spends quota to be told
 * the same thing twice.
 */
export async function generateWithRetry(
  provider: AIProvider,
  request: GenerateRequest,
  options: Partial<RetryOptions> = {}
): Promise<GenerateResult> {
  const { maxAttempts, delayMs, sleep } = { ...DEFAULT_RETRY, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await provider.generateStructuredResponse(request);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AIError && err.retryable;
      if (!retryable || attempt === maxAttempts) break;
      await sleep(delayMs(attempt));
    }
  }

  throw lastError;
}
