import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCorrelationChanges,
  applyCorrelationRules,
  correlationEventFingerprint,
  type CorrelationAlertConfig,
  type CorrelationSnapshot
} from "./correlation.js";

const MONITOR = "m1";
const WALLET = "walletA";

function config(overrides: Partial<CorrelationAlertConfig> = {}): CorrelationAlertConfig {
  return {
    enterStrongScore: 60,
    exitStrongScore: 45,
    minDelta: 10,
    minScore: 40,
    minConfidence: 0.5,
    cooldownHours: 24,
    notifyCorrelationChange: true,
    ...overrides
  };
}

function snap(overrides: Partial<CorrelationSnapshot> & { walletB: string }): CorrelationSnapshot {
  return {
    walletA: WALLET,
    pairId: [WALLET, overrides.walletB].sort().join("|"),
    correlationScore: 50,
    confidence: 0.7,
    classification: "PERSONAL",
    evidenceFamilies: [{ family: "sharedFunding", strength: 0.6 }],
    engineVersion: "correlation-v1.0.0",
    correlationResultId: "c1",
    ...overrides
  };
}

test("no previous snapshot and weak new correlation → no event", () => {
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, null, snap({ walletB: "walletB", correlationScore: 20 }), config());
  assert.equal(candidates.length, 0);
});

test("new correlation above threshold → CORRELATION_APPEARED with evidence", () => {
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, null, snap({ walletB: "walletB", correlationScore: 65 }), config());
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.equal(c.eventType, "CORRELATION_APPEARED");
  assert.equal(c.relatedWallet, "walletB");
  assert.equal(c.newScore, 65);
  assert.ok(c.evidence.correlationResultId);
  assert.ok(c.limitations.length > 0);
});

test("small delta below minDelta → no event", () => {
  const previous = snap({ walletB: "walletB", correlationScore: 50 });
  const current = snap({ walletB: "walletB", correlationScore: 55 });
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, previous, current, config());
  assert.equal(candidates.length, 0);
});

test("increase crossing strong band → CORRELATION_INCREASED with families diff", () => {
  const previous = snap({ walletB: "walletB", correlationScore: 50, evidenceFamilies: [{ family: "sharedFunding", strength: 0.6 }] });
  const current = snap({
    walletB: "walletB",
    correlationScore: 68,
    evidenceFamilies: [
      { family: "sharedFunding", strength: 0.6 },
      { family: "sharedMints", strength: 0.4 }
    ]
  });
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, previous, current, config());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.eventType, "CORRELATION_INCREASED");
  assert.equal(candidates[0]!.previousScore, 50);
  assert.equal(candidates[0]!.newScore, 68);
  assert.deepEqual(candidates[0]!.evidence.addedFamilies, ["sharedMints"]);
});

test("increase within strong band without crossing → no event (hysteresis)", () => {
  const previous = snap({ walletB: "walletB", correlationScore: 70 });
  const current = snap({ walletB: "walletB", correlationScore: 75 });
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, previous, current, config());
  assert.equal(candidates.length, 0);
});

test("decrease leaving strong band → CORRELATION_DECREASED", () => {
  const previous = snap({ walletB: "walletB", correlationScore: 70 });
  const current = snap({ walletB: "walletB", correlationScore: 30 });
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, previous, current, config());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.eventType, "CORRELATION_DECREASED");
  assert.equal(candidates[0]!.previousScore, 70);
  assert.equal(candidates[0]!.newScore, 30);
});

test("decrease not leaving strong band → no event", () => {
  const previous = snap({ walletB: "walletB", correlationScore: 80 });
  const current = snap({ walletB: "walletB", correlationScore: 65 });
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, previous, current, config());
  assert.equal(candidates.length, 0);
});

test("current missing but previous present → degraded DISAPPEARED with low confidence", () => {
  const previous = snap({ walletB: "walletB", correlationScore: 60 });
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, previous, null, config());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.eventType, "CORRELATION_DISAPPEARED");
  assert.equal(candidates[0]!.confidence, 0.4);
  assert.ok(candidates[0]!.evidence.degraded);
});

test("both missing → no event", () => {
  const candidates = evaluateCorrelationChanges(MONITOR, WALLET, null, null, config());
  assert.equal(candidates.length, 0);
});

test("fingerprint is stable and monitor-scoped", () => {
  const a = correlationEventFingerprint(MONITOR, "CORRELATION_INCREASED", "walletB");
  const b = correlationEventFingerprint(MONITOR, "CORRELATION_INCREASED", "walletB");
  const other = correlationEventFingerprint("m2", "CORRELATION_INCREASED", "walletB");
  assert.equal(a, b);
  assert.notEqual(a, other);
});

test("applyCorrelationRules: disabled notify suppresses", () => {
  const candidate = evaluateCorrelationChanges(MONITOR, WALLET, null, snap({ walletB: "walletB", correlationScore: 65 }), config())[0]!;
  const decisions = applyCorrelationRules([candidate], config({ notifyCorrelationChange: false }), {});
  assert.equal(decisions[0]!.action, "SUPPRESSED");
  assert.ok(decisions[0]!.reasons[0]!.includes("disabled"));
});

test("applyCorrelationRules: low confidence suppresses", () => {
  const candidate = evaluateCorrelationChanges(MONITOR, WALLET, null, snap({ walletB: "walletB", correlationScore: 65, confidence: 0.7 }), config())[0]!;
  const decisions = applyCorrelationRules([candidate], config({ minConfidence: 0.9 }), {});
  assert.equal(decisions[0]!.action, "SUPPRESSED");
  assert.ok(decisions[0]!.reasons[0]!.includes("confidence"));
});

test("applyCorrelationRules: cooldown suppresses same fingerprint", () => {
  const candidate = evaluateCorrelationChanges(MONITOR, WALLET, null, snap({ walletB: "walletB", correlationScore: 65 }), config())[0]!;
  const decisions = applyCorrelationRules([candidate], config(), {
    recentSameFingerprint: { fingerprint: candidate.fingerprint, lastSeenAt: new Date().toISOString(), occurrenceCount: 1 }
  });
  assert.equal(decisions[0]!.action, "SUPPRESSED");
  assert.ok(decisions[0]!.reasons[0]!.includes("cooldown"));
});

test("applyCorrelationRules: repeated increase must exceed last score (oscillation guard)", () => {
  const previous = snap({ walletB: "walletB", correlationScore: 50 });
  const current = snap({ walletB: "walletB", correlationScore: 65 });
  const candidate = evaluateCorrelationChanges(MONITOR, WALLET, previous, current, config())[0]!;
  assert.equal(candidate.eventType, "CORRELATION_INCREASED");
  const decisions = applyCorrelationRules([candidate], config(), { lastScore: 70 });
  assert.equal(decisions[0]!.action, "SUPPRESSED");
  assert.ok(decisions[0]!.reasons[0]!.includes("hysteresis"));
  // A later score that exceeds the last one notifies again.
  const current2 = snap({ walletB: "walletB", correlationScore: 75 });
  const candidate2 = evaluateCorrelationChanges(MONITOR, WALLET, previous, current2, config())[0]!;
  const decisions2 = applyCorrelationRules([candidate2], config(), { lastScore: 70 });
  assert.equal(decisions2[0]!.action, "NOTIFY");
});

test("applyCorrelationRules: qualifying candidate notifies", () => {
  const candidate = evaluateCorrelationChanges(MONITOR, WALLET, null, snap({ walletB: "walletB", correlationScore: 65 }), config())[0]!;
  const decisions = applyCorrelationRules([candidate], config(), {});
  assert.equal(decisions[0]!.action, "NOTIFY");
});
