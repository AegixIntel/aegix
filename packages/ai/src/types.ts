import { z } from "zod";

export const AI_ENGINE_VERSION = "ask-aegix-v1.0.0";

/**
 * Failure taxonomy.
 *
 * The split that matters is transient versus not: a timeout is worth
 * retrying, a response that failed validation is not — retrying it burns
 * quota to be told the same thing again.
 */
export type AIErrorCode =
  | "MISSING_CREDENTIAL"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "TRUNCATED"
  | "MALFORMED_RESPONSE"
  | "PROVIDER_ERROR";

const TRANSIENT: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>(["RATE_LIMIT", "TIMEOUT", "PROVIDER_ERROR"]);

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly retryable: boolean;

  constructor(code: AIErrorCode, message: string) {
    super(message);
    this.name = "AIError";
    this.code = code;
    this.retryable = TRANSIENT.has(code);
  }
}

/**
 * The shape a model must return.
 *
 * Every finding cites evidence by ID. A finding that cites nothing has
 * nothing behind it, and one that cites an ID AEGIX never issued is a
 * fabrication — both are removed before anything reaches a caller.
 */
export const findingSchema = z.object({
  statement: z.string().min(1).max(600),
  evidenceIds: z.array(z.string().min(1).max(120)).max(12)
});

export const structuredAnswerSchema = z.object({
  summary: z.string().min(1).max(2000),
  findings: z.array(findingSchema).max(12),
  limitations: z.array(z.string().min(1).max(400)).max(12)
});

export type Finding = z.infer<typeof findingSchema>;
export type StructuredAnswer = z.infer<typeof structuredAnswerSchema>;

export interface GenerateRequest {
  /** System framing. Never contains chain-derived text. */
  system: string;
  /** The user question, already sanitised. */
  question: string;
  /** Bounded, fenced evidence block. */
  evidenceBlock: string;
  /** Model identifier, from configuration. */
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface GenerateResult {
  answer: StructuredAnswer;
  model: string;
  /** Provider-reported token usage, when it reports any. */
  usage: { promptTokens: number | null; completionTokens: number | null };
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  /** True when the provider holds everything it needs to be called. */
  isConfigured(): boolean;
  generateStructuredResponse(request: GenerateRequest): Promise<GenerateResult>;
}
