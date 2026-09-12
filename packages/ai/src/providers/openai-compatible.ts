import { AIError, structuredAnswerSchema, type AIProvider, type GenerateRequest, type GenerateResult } from "../types.js";

export interface OpenAICompatibleOptions {
  /** Base URL of an OpenAI-compatible API, e.g. Groq's `/openai/v1` endpoint. */
  baseUrl: string | undefined;
  apiKey: string | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Adapter for any OpenAI-compatible chat completions endpoint.
 *
 * Groq is reached by pointing `baseUrl` at its OpenAI-compatible path and
 * naming a Groq model in configuration. Nothing here is specific to one
 * vendor or one model: substituting a provider is a configuration change, and
 * that is the point of the boundary.
 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): AIProvider {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "openai-compatible",

    isConfigured() {
      return Boolean(options.apiKey && options.baseUrl);
    },

    async generateStructuredResponse(request: GenerateRequest): Promise<GenerateResult> {
      if (!options.apiKey || !options.baseUrl) {
        throw new AIError("MISSING_CREDENTIAL", "No AI provider credential is configured");
      }

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);

      let response: Response;
      try {
        response = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxOutputTokens,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: `${request.evidenceBlock}\n\nQuestion: ${request.question}` }
            ]
          })
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new AIError("TIMEOUT", `Provider did not respond within ${request.timeoutMs}ms`);
        }
        throw new AIError("PROVIDER_ERROR", "Provider request failed");
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        throw new AIError("RATE_LIMIT", "Provider rate limit reached");
      }
      if (response.status === 401 || response.status === 403) {
        // The body may quote the credential back; it is never surfaced.
        throw new AIError("MISSING_CREDENTIAL", "Provider rejected the configured credential");
      }
      if (!response.ok) {
        throw new AIError("PROVIDER_ERROR", `Provider responded with status ${response.status}`);
      }

      let body: ChatCompletionResponse;
      try {
        body = (await response.json()) as ChatCompletionResponse;
      } catch {
        throw new AIError("MALFORMED_RESPONSE", "Provider response was not JSON");
      }

      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new AIError("TRUNCATED", "Provider response was cut off by the output limit");
      }

      const content = choice?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new AIError("MALFORMED_RESPONSE", "Provider returned no content");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new AIError("MALFORMED_RESPONSE", "Provider content was not valid JSON");
      }

      const validated = structuredAnswerSchema.safeParse(parsed);
      if (!validated.success) {
        throw new AIError("MALFORMED_RESPONSE", "Provider content did not match the answer schema");
      }

      return {
        answer: validated.data,
        model: request.model,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? null,
          completionTokens: body.usage?.completion_tokens ?? null
        },
        latencyMs: Date.now() - started
      };
    }
  };
}
