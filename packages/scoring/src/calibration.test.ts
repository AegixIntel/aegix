import assert from "node:assert/strict";
import { test } from "node:test";
import { computeConfidence } from "./scoring.js";
import { computeDataQuality } from "./data-quality.js";

function baseInput(overrides: Record<string, number | undefined> = {}) {
  return {
    repeatedFunding: 0,
    repeatedCounterparty: 0,
    knownEntityInteractions: 0,
    clusterLinks: 0,
    behavioralSignals: 0,
    counterpartyConcentration: 0,
    uniqueCounterparties: 0,
    fundingConcentration: 0,
    transactionCount: 1000,
    historyDays: 300,
    parserFailures: 0,
    transactionsRequested: 1000,
    transactionsReceived: 1000,
    ...overrides
  };
}

test("confidence is penalized by unknown program ratio", () => {
  const clean = computeConfidence(baseInput());
  const dirty = computeConfidence(baseInput({ unknownProgramRatio: 0.9 }));
  assert.ok(dirty < clean);
});

test("confidence is penalized by RPC failures", () => {
  const clean = computeConfidence(baseInput());
  const degraded = computeConfidence(baseInput({ rpcFailureRatio: 0.5 }));
  assert.ok(degraded < clean);
});

test("behavioral-only evidence is confidence-capped", () => {
  const behavioral = computeConfidence(
    baseInput({
      behavioralSignals: 80,
      transactionCount: 5000,
      historyDays: 500,
      supportingEngines: 3
    })
  );
  assert.ok(behavioral <= 0.6, `expected cap 0.6, got ${behavioral}`);
});

test("engine agreement provides a modest bonus", () => {
  const alone = computeConfidence(baseInput({ repeatedFunding: 70, transactionCount: 50, historyDays: 30 }));
  const agreed = computeConfidence(baseInput({ repeatedFunding: 70, transactionCount: 50, historyDays: 30, supportingEngines: 4 }));
  assert.ok(agreed > alone);
  assert.ok(agreed - alone <= 0.06);
});

test("data quality score reflects parser success and coverage", () => {
  const good = computeDataQuality({
    transactionsRequested: 1000,
    transactionsReceived: 990,
    transactionsParsed: 990,
    parserFailures: 0,
    rpcFailures: 10,
    unknownProgramCount: 100,
    programInteractionCount: 1000,
    historyStart: "2026-01-01T00:00:00Z",
    historyEnd: "2026-08-01T00:00:00Z",
    maxHistoryDays: 365,
    maxTransactions: 2000
  });
  assert.ok(good.dataQualityScore >= 75);
  assert.equal(good.grade, "HIGH");

  const poor = computeDataQuality({
    transactionsRequested: 1000,
    transactionsReceived: 120,
    transactionsParsed: 100,
    parserFailures: 20,
    rpcFailures: 880,
    unknownProgramCount: 900,
    programInteractionCount: 1000,
    historyStart: null,
    historyEnd: null,
    maxHistoryDays: 365,
    maxTransactions: 2000
  });
  assert.ok(poor.dataQualityScore < 45);
  assert.equal(poor.grade, "LOW");
});
