import assert from "node:assert/strict";
import { test } from "node:test";
import { AIError, type AIProvider, type GenerateRequest } from "./types.js";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { ASK_AEGIX_SYSTEM_PROMPT, generateWithRetry } from "./index.js";

const REQUEST: GenerateRequest = {
  system: ASK_AEGIX_SYSTEM_PROMPT,
  question: "What funded this wallet?",
  evidenceBlock: "<untrusted-chain-data>\nind:A | Repeated funding\n</untrusted-chain-data>",
  model: "llama-3.3-70b-versatile",
  maxOutputTokens: 800,
  timeoutMs: 5000
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function completion(content: string, finishReason: string | null = "stop"): Response {
  return jsonResponse({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 20 }
  });
}

test("a provider without a credential reports it as unconfigured", () => {
  const provider = createOpenAICompatibleProvider({ baseUrl: "https://example.invalid/v1", apiKey: undefined });
  assert.equal(provider.isConfigured(), false);
});

test("calling an unconfigured provider fails with MISSING_CREDENTIAL, not a network error", async () => {
  const provider = createOpenAICompatibleProvider({ baseUrl: undefined, apiKey: undefined });
  await assert.rejects(
    () => provider.generateStructuredResponse(REQUEST),
    (err: unknown) => err instanceof AIError && err.code === "MISSING_CREDENTIAL"
  );
});

test("a valid structured response is parsed and returned", async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    fetchImpl: async () =>
      completion(JSON.stringify({ summary: "s", findings: [{ statement: "f", evidenceIds: ["ind:A"] }], limitations: [] }))
  });

  const result = await provider.generateStructuredResponse(REQUEST);
  assert.equal(result.answer.summary, "s");
  assert.equal(result.usage.promptTokens, 100);
  assert.equal(result.model, REQUEST.model);
});

test("the credential never leaves the module, even on rejection", async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "super-secret-key",
    fetchImpl: async () => jsonResponse({ error: { message: "Invalid API key: super-secret-key" } }, 401)
  });

  await assert.rejects(
    () => provider.generateStructuredResponse(REQUEST),
    (err: unknown) => {
      assert.ok(err instanceof AIError);
      assert.equal(err.code, "MISSING_CREDENTIAL");
      assert.ok(!err.message.includes("super-secret-key"));
      return true;
    }
  );
});

test("non-JSON content is MALFORMED_RESPONSE rather than a crash", async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    fetchImpl: async () => completion("I'm afraid I can't do that.")
  });

  await assert.rejects(
    () => provider.generateStructuredResponse(REQUEST),
    (err: unknown) => err instanceof AIError && err.code === "MALFORMED_RESPONSE"
  );
});

test("JSON that does not match the schema is rejected", async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    fetchImpl: async () => completion(JSON.stringify({ answer: "wrong shape" }))
  });

  await assert.rejects(
    () => provider.generateStructuredResponse(REQUEST),
    (err: unknown) => err instanceof AIError && err.code === "MALFORMED_RESPONSE"
  );
});

test("a cut-off response is TRUNCATED, not silently half an answer", async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    fetchImpl: async () => completion(JSON.stringify({ summary: "partial", findings: [], limitations: [] }), "length")
  });

  await assert.rejects(
    () => provider.generateStructuredResponse(REQUEST),
    (err: unknown) => err instanceof AIError && err.code === "TRUNCATED"
  );
});

test("rate limiting and server errors map to their own codes", async () => {
  for (const [status, code] of [[429, "RATE_LIMIT"], [500, "PROVIDER_ERROR"]] as const) {
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      fetchImpl: async () => jsonResponse({}, status)
    });
    await assert.rejects(
      () => provider.generateStructuredResponse(REQUEST),
      (err: unknown) => err instanceof AIError && err.code === code
    );
  }
});

test("an aborted request becomes TIMEOUT", async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    fetchImpl: async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
  });

  await assert.rejects(
    () => provider.generateStructuredResponse(REQUEST),
    (err: unknown) => err instanceof AIError && err.code === "TIMEOUT"
  );
});

test("transient failures are retried", async () => {
  let attempts = 0;
  const provider: AIProvider = {
    name: "stub",
    isConfigured: () => true,
    generateStructuredResponse: async () => {
      attempts++;
      if (attempts < 3) throw new AIError("RATE_LIMIT", "slow down");
      return {
        answer: { summary: "ok", findings: [], limitations: [] },
        model: "m",
        usage: { promptTokens: null, completionTokens: null },
        latencyMs: 1
      };
    }
  };

  const result = await generateWithRetry(provider, REQUEST, { sleep: async () => {} });
  assert.equal(attempts, 3);
  assert.equal(result.answer.summary, "ok");
});

test("a malformed response is not retried: the answer would be the same", async () => {
  let attempts = 0;
  const provider: AIProvider = {
    name: "stub",
    isConfigured: () => true,
    generateStructuredResponse: async () => {
      attempts++;
      throw new AIError("MALFORMED_RESPONSE", "bad shape");
    }
  };

  await assert.rejects(() => generateWithRetry(provider, REQUEST, { sleep: async () => {} }));
  assert.equal(attempts, 1);
});

test("a missing credential is not retried", async () => {
  let attempts = 0;
  const provider: AIProvider = {
    name: "stub",
    isConfigured: () => false,
    generateStructuredResponse: async () => {
      attempts++;
      throw new AIError("MISSING_CREDENTIAL", "no key");
    }
  };

  await assert.rejects(() => generateWithRetry(provider, REQUEST, { sleep: async () => {} }));
  assert.equal(attempts, 1);
});

test("the system prompt forbids the claims the engines refuse to make", () => {
  const prompt = ASK_AEGIX_SYSTEM_PROMPT.toLowerCase();

  assert.ok(prompt.includes("not shared ownership or identity"));
  assert.ok(prompt.includes("not fraud"));
  assert.ok(prompt.includes("not causation"));
  assert.ok(prompt.includes("not the wallet"));
  assert.ok(prompt.includes("cite every"));
});

test("reasoning is switched off only when the operator asks for it", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return completion(JSON.stringify({ summary: "s", findings: [], limitations: [] }));
  }) as typeof fetch;
  await createOpenAICompatibleProvider({ baseUrl: "https://example.invalid/v1", apiKey: "test-key", fetchImpl }).generateStructuredResponse(REQUEST);
  await createOpenAICompatibleProvider({ baseUrl: "https://example.invalid/v1", apiKey: "test-key", disableThinking: true, fetchImpl }).generateStructuredResponse(REQUEST);
  assert.equal("thinking" in bodies[0]!, false);
  assert.deepEqual(bodies[1]!.thinking, { type: "disabled" });
});
