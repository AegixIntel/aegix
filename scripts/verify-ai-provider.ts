/**
 * Ask AEGIX provider verification (D9).
 *
 * Reports what is actually true of the configured provider, one stage at a
 * time. Each stage can only pass by doing the thing it names, so a run
 * against an unconfigured environment reports NOT CONFIGURED rather than
 * anything that could be mistaken for success.
 *
 * Usage: pnpm verify:ai-provider
 */

import { loadConfig } from "@aegix/config";
import {
  ASK_AEGIX_SYSTEM_PROMPT,
  AIError,
  buildBoundedContext,
  createOpenAICompatibleProvider,
  enforceGrounding
} from "@aegix/ai";

type Status = "PASS" | "FAIL" | "NOT CONFIGURED" | "SKIPPED";

const results: Array<{ stage: string; status: Status; detail: string }> = [];

function record(stage: string, status: Status, detail: string): void {
  results.push({ stage, status, detail });
}

/** A fixture with evidence IDs the model cannot have seen anywhere else. */
const EVIDENCE = [
  {
    id: "ind:VERIFY_FUNDING",
    label: "Repeated funding",
    detail: "The same source funded this wallet on 4 occasions within the analysed history.",
    severity: 62,
    confidence: 0.78
  },
  {
    id: "dim:verifyDimension",
    label: "Funding Exposure",
    detail: "Score dimension fundingExposure = 55 of 100.",
    severity: 55,
    confidence: 1
  }
];

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const provider = createOpenAICompatibleProvider({
    baseUrl: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY
  });

  if (!provider.isConfigured()) {
    record("CONFIGURED", "NOT CONFIGURED", "LLM_BASE_URL and LLM_API_KEY are required");
    for (const stage of ["PROVIDER REACHABLE", "STRUCTURED RESPONSE", "EVIDENCE GROUNDING", "FABRICATION REJECTED"]) {
      record(stage, "SKIPPED", "no credential");
    }
    report();
    process.exitCode = 1;
    return;
  }

  record("CONFIGURED", "PASS", `model ${config.LLM_MODEL}`);

  const context = buildBoundedContext(EVIDENCE);
  let answer;
  try {
    const generated = await provider.generateStructuredResponse({
      system: ASK_AEGIX_SYSTEM_PROMPT,
      question: "What does the evidence say about how this wallet was funded?",
      evidenceBlock: context.block,
      model: config.LLM_MODEL,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
      timeoutMs: config.AI_TIMEOUT_MS
    });
    answer = generated.answer;
    record("PROVIDER REACHABLE", "PASS", `${generated.latencyMs}ms, model ${generated.model}`);
    record("STRUCTURED RESPONSE", "PASS", `${answer.findings.length} finding(s) matched the schema`);
  } catch (err) {
    const code = err instanceof AIError ? err.code : "PROVIDER_ERROR";
    record("PROVIDER REACHABLE", "FAIL", code);
    record("STRUCTURED RESPONSE", "SKIPPED", "no response");
    record("EVIDENCE GROUNDING", "SKIPPED", "no response");
    record("FABRICATION REJECTED", "SKIPPED", "no response");
    report();
    process.exitCode = 1;
    return;
  }

  const grounded = enforceGrounding(answer, context.includedIds);
  const citesReal = grounded.answer.findings.some((f) => f.evidenceIds.length > 0);
  record(
    "EVIDENCE GROUNDING",
    citesReal ? "PASS" : "FAIL",
    citesReal
      ? `${grounded.answer.findings.length} grounded finding(s), ${grounded.droppedReferences} citation(s) dropped`
      : "no finding survived citation checking"
  );

  // The validator must remove an ID that was never issued, whatever the model
  // returned. This stage tests AEGIX, not the provider.
  const fabricated = enforceGrounding(
    { summary: "s", findings: [{ statement: "invented", evidenceIds: ["ind:NEVER_ISSUED"] }], limitations: [] },
    context.includedIds
  );
  record(
    "FABRICATION REJECTED",
    fabricated.answer.findings.length === 0 ? "PASS" : "FAIL",
    `${fabricated.droppedFindings} fabricated finding(s) removed`
  );

  report();
  if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
}

function report(): void {
  console.log("\nASK AEGIX PROVIDER VERIFICATION\n");
  for (const { stage, status, detail } of results) {
    console.log(`${stage.padEnd(24)} ${status.padEnd(16)} ${detail}`);
  }
  console.log("");
}

void main();
