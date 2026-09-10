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
    transactionsReceived: 800,
    largeTransferExposure: 80,
    highFrequencyExposure: 70,
    oddHourExposure: 60,
    regularIntervalExposure: 50
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

/** Baseline with no optional inputs, used to isolate one input at a time. */
const BASE = {
  repeatedFunding: 40,
  repeatedCounterparty: 40,
  knownEntityInteractions: 40,
  clusterLinks: 40,
  behavioralSignals: 40,
  counterpartyConcentration: 0.4,
  uniqueCounterparties: 10,
  fundingConcentration: 0.4,
  transactionCount: 100,
  historyDays: 90,
  parserFailures: 0,
  transactionsRequested: 100,
  transactionsReceived: 100
};

test("public attribution raises identity linkability", () => {
  const without = scoreWallet(BASE);
  const with90 = scoreWallet({ ...BASE, publicAttribution: 90 });

  assert.ok(
    with90.dimensions.identityLinkability > without.dimensions.identityLinkability,
    "public attribution must move the dimension it is weighted into"
  );
  assert.ok(with90.overallScore > without.overallScore);
});

test("omitting public attribution scores exactly as before it existed", () => {
  assert.deepEqual(scoreWallet(BASE), scoreWallet({ ...BASE, publicAttribution: 0 }));
});

test("measured transaction patterns drive the transaction pattern dimension", () => {
  const quiet = scoreWallet({
    ...BASE,
    largeTransferExposure: 0,
    highFrequencyExposure: 0,
    oddHourExposure: 0
  });
  const distinctive = scoreWallet({
    ...BASE,
    largeTransferExposure: 90,
    highFrequencyExposure: 80,
    oddHourExposure: 70
  });

  assert.ok(distinctive.dimensions.transactionPatternExposure > quiet.dimensions.transactionPatternExposure);
  assert.equal(quiet.dimensions.transactionPatternExposure, 0);
});

test("missing transaction-pattern evidence fails closed instead of using a volume proxy", () => {
  const withoutEvidence = scoreWallet(BASE);
  assert.equal(withoutEvidence.dimensions.transactionPatternExposure, 0);
  assert.deepEqual(withoutEvidence, scoreWallet({
    ...BASE,
    largeTransferExposure: 0,
    highFrequencyExposure: 0,
    oddHourExposure: 0,
    regularIntervalExposure: 0
  }));
});

test("measured interval regularity drives the behavioural fingerprint", () => {
  const irregular = scoreWallet({ ...BASE, regularIntervalExposure: 0 });
  const periodic = scoreWallet({ ...BASE, regularIntervalExposure: 100 });

  assert.ok(periodic.dimensions.behavioralFingerprint > irregular.dimensions.behavioralFingerprint);
});

test("public attribution is hard evidence, so it lifts the behavioural confidence cap", () => {
  const behaviouralOnly = computeConfidence({
    ...BASE,
    repeatedFunding: 0,
    repeatedCounterparty: 0,
    knownEntityInteractions: 0,
    transactionCount: 800,
    historyDays: 400,
    transactionsRequested: 800,
    transactionsReceived: 800
  });
  const withAttribution = computeConfidence({
    ...BASE,
    repeatedFunding: 0,
    repeatedCounterparty: 0,
    knownEntityInteractions: 0,
    transactionCount: 800,
    historyDays: 400,
    transactionsRequested: 800,
    transactionsReceived: 800,
    publicAttribution: 80
  });

  assert.ok(behaviouralOnly <= 0.6, `behavioural-only must stay capped, got ${behaviouralOnly}`);
  assert.ok(withAttribution > behaviouralOnly);
});
