import assert from "node:assert/strict";
import { test } from "node:test";
import { computeConfidence, scoreWallet } from "./scoring.js";

test("empty wallet scores low with low confidence", () => {
  const result = scoreWallet({
    repeatedFunding: 0,
    repeatedCounterparty: 0,
    knownEntityInteractions: 0,
    clusterLinks: 0,
    behavioralSignals: 0,
    counterpartyConcentration: 0,
    uniqueCounterparties: 0,
    fundingConcentration: 0,
    transactionCount: 0,
    historyDays: 0,
    parserFailures: 0,
    transactionsRequested: 0,
    transactionsReceived: 0
  });

  assert.equal(result.overallScore, 0);
  assert.ok(result.overallConfidence < 0.5);
});

test("heavily linked wallet scores high", () => {
  const result = scoreWallet({
    repeatedFunding: 90,
    repeatedCounterparty: 85,
    knownEntityInteractions: 70,
    clusterLinks: 60,
    behavioralSignals: 50,
    counterpartyConcentration: 0.9,
    uniqueCounterparties: 20,
    fundingConcentration: 0.9,
    transactionCount: 800,
    historyDays: 300,
    parserFailures: 5,
    transactionsRequested: 805,
    transactionsReceived: 800
  });

  assert.ok(result.overallScore >= 60, `expected high score, got ${result.overallScore}`);
  assert.ok(result.overallConfidence > 0.8);
});

test("confidence grows with sample size and completeness", () => {
  const low = computeConfidence({
    repeatedFunding: 0,
    repeatedCounterparty: 0,
    knownEntityInteractions: 0,
    clusterLinks: 0,
    behavioralSignals: 0,
    counterpartyConcentration: 0,
    uniqueCounterparties: 0,
    fundingConcentration: 0,
    transactionCount: 10,
    historyDays: 5,
    parserFailures: 0,
    transactionsRequested: 10,
    transactionsReceived: 10
  });
  const high = computeConfidence({
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
    transactionsReceived: 1000
  });

  assert.ok(high > low);
});
