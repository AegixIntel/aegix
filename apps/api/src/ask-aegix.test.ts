import assert from "node:assert/strict";
import { test } from "node:test";
import { buildServer } from "./server.js";
import { loadConfig } from "@aegix/config";
import { profileToEvidence } from "./ask-aegix.js";
import type { WalletContextProfile } from "@aegix/context";

const VALID_WALLET = "So11111111111111111111111111111111111111112";

function testConfig(over: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379",
    ...over
  });
}

function profile(over: Partial<WalletContextProfile> = {}): WalletContextProfile {
  return {
    wallet: VALID_WALLET,
    analysisId: "analysis-1",
    sufficiency: "SUFFICIENT",
    indicators: [],
    suppressed: [],
    linkability: { converged: false, contributingCategories: [], severity: null, confidence: null, note: "none" },
    knownRisk: { dataset: "NOT_AVAILABLE", match: "NOT_CHECKED", note: "no dataset" },
    dimensions: [],
    coverage: { transactionsParsed: 12, historyStart: null, historyEnd: null, dataQualityScore: 70, grade: "MEDIUM" },
    limitations: [],
    engineVersions: { context: "context-v1.0.0", pipeline: null, scoring: null },
    ...over
  };
}

test("ask aegix: the kill switch retires the surface", async () => {
  const app = await buildServer({ config: testConfig({ ENABLE_ASK_AEGIX: "false" }) });
  const res = await app.inject({
    method: "POST",
    url: `/v1/wallets/${VALID_WALLET}/ask`,
    payload: { question: "What funded this wallet?" }
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "FEATURE_DISABLED");
  await app.close();
});

test("ask aegix: requires an authenticated session", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({
    method: "POST",
    url: `/v1/wallets/${VALID_WALLET}/ask`,
    payload: { question: "What funded this wallet?" }
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test("ask aegix: a missing question is rejected by the schema", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({ method: "POST", url: `/v1/wallets/${VALID_WALLET}/ask`, payload: {} });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test("fail-open: deterministic routes serve with no AI provider configured", async () => {
  // No LLM_API_KEY, no LLM_BASE_URL anywhere in this config.
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({
    method: "GET",
    url: "/v1/wallets/11111111111111111111111111111111111111111111/x-ray"
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "INVALID_WALLET");
  await app.close();
});

test("fail-open: health does not depend on the AI provider", async () => {
  const app = await buildServer({ config: testConfig() });
  const res = await app.inject({ method: "GET", url: "/health/live" });

  assert.equal(res.statusCode, 200);
  await app.close();
});

test("evidence: every indicator, dimension and coverage fact is citable", () => {
  const items = profileToEvidence(
    profile({
      indicators: [
        {
          id: "ind:REPEATED_FUNDING",
          signalType: "REPEATED_FUNDING",
          category: "FUNDING",
          severity: 60,
          confidence: 0.8,
          title: "Repeated funding",
          description: "Observed repeated funding.",
          sourceEngine: "funding",
          engineVersion: "funding-v1.0.0",
          evidence: [{ key: "count", value: 4, label: "Occurrences" }],
          evidenceRefs: ["sig:REPEATED_FUNDING"]
        }
      ],
      dimensions: [{ id: "dim:fundingExposure", key: "fundingExposure", label: "Funding Exposure", score: 55 }]
    })
  );

  const ids = items.map((i) => i.id);
  assert.ok(ids.includes("ind:REPEATED_FUNDING"));
  assert.ok(ids.includes("dim:fundingExposure"));
  assert.ok(ids.includes("cov:analysis"));
});

test("evidence: indicator text is marked untrusted so it is sanitised", () => {
  const items = profileToEvidence(
    profile({
      indicators: [
        {
          id: "ind:X",
          signalType: "X",
          category: "ENTITY",
          severity: 10,
          confidence: 0.1,
          title: "t",
          description: "d",
          sourceEngine: "entities",
          engineVersion: "entities-v1.0.0",
          evidence: [],
          evidenceRefs: ["sig:X"]
        }
      ]
    })
  );

  assert.equal(items[0]?.untrusted, true);
});

test("evidence: the coverage item states the known-risk position", () => {
  const items = profileToEvidence(profile());
  const coverage = items.find((i) => i.id === "cov:analysis");

  assert.ok(coverage);
  assert.ok(coverage.detail.includes("NOT_AVAILABLE"));
  assert.ok(coverage.detail.includes("NOT_CHECKED"));
});
