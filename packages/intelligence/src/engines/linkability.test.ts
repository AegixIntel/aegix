import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntelligenceSignal, SignalCategory } from "@aegix/types";
import { analyzeLinkability } from "./linkability.js";

const WALLET = "walletA";

function signal(category: SignalCategory, severity: number, confidence = 0.7): IntelligenceSignal {
  return {
    type: `${category}_TEST`,
    category,
    severity,
    confidence,
    title: `${category} signal`,
    summary: "test",
    evidence: [],
    engineVersion: "test-v1"
  };
}

test("no signals means no linkability", () => {
  const result = analyzeLinkability({ walletAddress: WALLET, signals: [] });

  assert.equal(result.signals.length, 0);
  assert.equal(result.converged, false);
  assert.equal(result.identityLinkabilityExposure, 0);
});

test("a single evidence class does not converge", () => {
  const result = analyzeLinkability({ walletAddress: WALLET, signals: [signal("FUNDING", 70)] });

  assert.equal(result.converged, false);
  assert.equal(result.signals.length, 0, "one class is never a convergence claim");
  assert.equal(result.contributions.length, 1);
});

test("statistical evidence alone cannot produce a linkability claim", () => {
  const result = analyzeLinkability({
    walletAddress: WALLET,
    signals: [signal("BEHAVIORAL", 60), signal("TRANSACTION_PATTERN", 80), signal("CLUSTER", 75)]
  });

  assert.equal(result.converged, false);
  assert.equal(result.signals.length, 0);
  assert.ok(
    result.identityLinkabilityExposure <= 35,
    `inferred-only evidence must stay capped, got ${result.identityLinkabilityExposure}`
  );
});

test("observed evidence converging with inferred evidence raises a signal", () => {
  const result = analyzeLinkability({
    walletAddress: WALLET,
    signals: [signal("FUNDING", 70), signal("BEHAVIORAL", 50)]
  });

  const s = result.signals.find((x) => x.type === "CONVERGING_LINKABILITY_EVIDENCE");
  assert.ok(s, "expected a convergence signal");
  assert.equal(s.category, "IDENTITY_LINKABILITY");
  assert.equal(result.converged, true);
  assert.ok(result.identityLinkabilityExposure > 70, `got ${result.identityLinkabilityExposure}`);
});

test("more converging classes raise exposure, bounded", () => {
  const two = analyzeLinkability({
    walletAddress: WALLET,
    signals: [signal("FUNDING", 70), signal("BEHAVIORAL", 50)]
  });
  const four = analyzeLinkability({
    walletAddress: WALLET,
    signals: [
      signal("FUNDING", 70),
      signal("BEHAVIORAL", 50),
      signal("COUNTERPARTY", 60),
      signal("PUBLIC_ATTRIBUTION", 65)
    ]
  });

  assert.ok(four.identityLinkabilityExposure > two.identityLinkabilityExposure);
  assert.ok(four.identityLinkabilityExposure <= 100);
});

test("confidence never reaches certainty", () => {
  const result = analyzeLinkability({
    walletAddress: WALLET,
    signals: [signal("FUNDING", 90, 0.99), signal("PUBLIC_ATTRIBUTION", 95, 0.99), signal("CLUSTER", 80, 0.99)]
  });

  assert.equal(result.signals.length, 1);
  assert.ok(result.signals[0]!.confidence <= 0.9, `got ${result.signals[0]!.confidence}`);
  assert.match(result.signals[0]!.summary, /does not establish who controls it/);
});

test("the engine never feeds on its own output", () => {
  const prior = signal("IDENTITY_LINKABILITY", 95);
  const result = analyzeLinkability({ walletAddress: WALLET, signals: [prior, signal("FUNDING", 40)] });

  assert.equal(result.contributions.length, 1);
  assert.equal(result.contributions[0]!.evidenceClass, "FUNDING");
  assert.equal(result.converged, false);
});

test("contributions report observed and inferred classes separately", () => {
  const result = analyzeLinkability({
    walletAddress: WALLET,
    signals: [signal("PUBLIC_ATTRIBUTION", 80), signal("BEHAVIORAL", 40)]
  });

  const byClass = new Map(result.contributions.map((c) => [c.evidenceClass, c]));
  assert.equal(byClass.get("PUBLIC_ATTRIBUTION")!.observed, true);
  assert.equal(byClass.get("BEHAVIORAL")!.observed, false);
});
