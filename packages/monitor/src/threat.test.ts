import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRules,
  evaluateThreats,
  eventFingerprint,
  severityAtLeast
} from "./threat.js";
import type { MonitorAlertRules, ExposureDiff } from "@aegix/types";

function rules(overrides: Partial<MonitorAlertRules> = {}): MonitorAlertRules {
  return {
    id: "1",
    monitorId: "m1",
    minimumSeverity: "HIGH",
    minimumConfidence: 0.6,
    overallScoreDeltaThreshold: 10,
    notifyNewEntity: true,
    notifyNewAttackPath: true,
    notifyBehaviorChange: false,
    notifyDataQualityDegraded: true,
    cooldownHours: 24,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function baseDiff(overrides: Partial<ExposureDiff> = {}): ExposureDiff {
  return {
    monitorId: "m1",
    previousAnalysisId: "prev",
    currentAnalysisId: "curr",
    overallChange: { previous: 30, current: 30, delta: 0, direction: "UNCHANGED" },
    dimensionChanges: [],
    newSignals: [],
    removedSignals: [],
    changedSignals: [],
    entityChanges: [],
    relationshipChanges: [],
    behaviorChanges: [],
    attackPathChanges: [],
    dataQualityChange: {
      previous: { score: 80, semanticCoverage: 70 },
      current: { score: 80, semanticCoverage: 70 },
      degraded: false,
      material: false
    },
    comparability: {
      comparable: true,
      reason: null,
      engineVersionChanged: false,
      scoringVersionChanged: false,
      previousEngineVersion: "v1",
      currentEngineVersion: "v1"
    },
    confidence: 0.8,
    diffVersion: "diff-v1.0.0",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

test("NO_CHANGE diff produces no candidates", () => {
  const candidates = evaluateThreats(baseDiff(), "wallet");
  assert.equal(candidates.length, 0);
});

test("PRIVACY_EXPOSURE_INCREASED: severity bands and confidence", () => {
  const diff = baseDiff({
    overallChange: { previous: 24, current: 61, delta: 37, direction: "INCREASED" }
  });
  const candidates = evaluateThreats(diff, "wallet");
  const event = candidates.find((c) => c.eventType === "PRIVACY_EXPOSURE_INCREASED");
  assert.ok(event);
  assert.equal(event.severity, "HIGH");
  assert.equal(event.subject, "OVERALL");
});

test("ENGINE_VERSION_CHANGE: score-based events suppressed, entity events discounted", () => {
  const diff = baseDiff({
    overallChange: { previous: 24, current: 61, delta: 37, direction: "INCREASED" },
    comparability: {
      comparable: false,
      reason: "engine version changed",
      engineVersionChanged: true,
      scoringVersionChanged: false,
      previousEngineVersion: "aegix-pipeline-v1.0.0",
      currentEngineVersion: "aegix-pipeline-v2.0.0"
    },
    entityChanges: [{
      entityName: "Coinbase",
      entityType: "CENTRALIZED_EXCHANGE",
      change: "NEW_ENTITY_EXPOSURE",
      previous: null,
      current: { count: 1, confidence: 0.9 }
    }]
  });
  const candidates = evaluateThreats(diff, "wallet");
  assert.ok(!candidates.some((c) => c.eventType === "PRIVACY_EXPOSURE_INCREASED"), "score-based event must be suppressed on version drift");
  const entity = candidates.find((c) => c.eventType === "NEW_ENTITY_EXPOSURE");
  assert.ok(entity, "identity-based events are still reported");
  assert.ok(entity.confidence < 0.6, "confidence is discounted on version drift");
});

test("DATA_QUALITY_DROP: only DATA_QUALITY_DEGRADED emitted, no false exposure reduction", () => {
  const diff = baseDiff({
    overallChange: { previous: 61, current: 30, delta: -31, direction: "DECREASED" },
    dataQualityChange: {
      previous: { score: 80, semanticCoverage: 70 },
      current: { score: 40, semanticCoverage: 22 },
      degraded: true,
      material: true
    }
  });
  const candidates = evaluateThreats(diff, "wallet");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.eventType, "DATA_QUALITY_DEGRADED");
});

test("DATA_QUALITY_DROP non-material: suppressed entirely", () => {
  const diff = baseDiff({
    dataQualityChange: {
      previous: { score: 80, semanticCoverage: 70 },
      current: { score: 70, semanticCoverage: 60 },
      degraded: true,
      material: false
    }
  });
  const candidates = evaluateThreats(diff, "wallet");
  assert.equal(candidates.length, 0);
});

test("NEW_REPEATED_FUNDER: evidence-backed event with severity by frequency", () => {
  const diff = baseDiff({
    relationshipChanges: [{
      counterparty: "FunderA",
      relationshipType: "REPEATED_FUNDING_RELATIONSHIP_CREATED",
      change: "NEW_REPEATED_COUNTERPARTY",
      previous: null,
      current: { transactionCount: 6, concentration: 0.4 }
    }]
  });
  const candidates = evaluateThreats(diff, "wallet");
  const event = candidates.find((c) => c.eventType === "NEW_REPEATED_FUNDER");
  assert.ok(event);
  assert.equal(event.severity, "HIGH"); // >= 5 repeated txs
  assert.equal(event.fingerprint, eventFingerprint("m1", "NEW_REPEATED_FUNDER", "funder:FunderA"));
});

test("EVENT_MERGING: >3 same-type events consolidate", () => {
  const diff = baseDiff({
    entityChanges: [
      { entityName: "A", entityType: null, change: "NEW_ENTITY_EXPOSURE", previous: null, current: { count: 1, confidence: 0.9 } },
      { entityName: "B", entityType: null, change: "NEW_ENTITY_EXPOSURE", previous: null, current: { count: 1, confidence: 0.9 } },
      { entityName: "C", entityType: null, change: "NEW_ENTITY_EXPOSURE", previous: null, current: { count: 1, confidence: 0.9 } },
      { entityName: "D", entityType: null, change: "NEW_ENTITY_EXPOSURE", previous: null, current: { count: 1, confidence: 0.9 } },
      { entityName: "E", entityType: null, change: "NEW_ENTITY_EXPOSURE", previous: null, current: { count: 1, confidence: 0.9 } }
    ]
  });
  const candidates = evaluateThreats(diff, "wallet");
  const entities = candidates.filter((c) => c.eventType === "NEW_ENTITY_EXPOSURE");
  assert.equal(entities.length, 3); // 2 kept + 1 consolidated
  assert.ok(entities.some((c) => c.subject === "multiple"));
});

test("RULES: severity floor suppresses LOW events", () => {
  const diff = baseDiff({
    overallChange: { previous: 30, current: 42, delta: 12, direction: "INCREASED" }
  });
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, rules({ minimumSeverity: "CRITICAL" }), {});
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.action, "SUPPRESSED");
  assert.match(decisions[0]?.reasons[0] ?? "", /below minimum/);
});

test("RULES: confidence floor suppresses low-confidence HIGH events", () => {
  const diff = baseDiff({
    overallChange: { previous: 30, current: 70, delta: 40, direction: "INCREASED" },
    confidence: 0.4
  });
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, rules(), {});
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.action, "SUPPRESSED");
  assert.match(decisions[0]?.reasons[0] ?? "", /confidence/);
});

test("RULES: score delta threshold suppresses +12 when threshold is 20", () => {
  const diff = baseDiff({
    overallChange: { previous: 30, current: 42, delta: 12, direction: "INCREASED" }
  });
  const candidates = evaluateThreats(diff, "wallet");
  // LOW-severity event passes a LOW minimum-severity rule but fails the delta threshold.
  const decisions = applyRules(candidates, rules({ minimumSeverity: "LOW", overallScoreDeltaThreshold: 20 }), {});
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.action, "SUPPRESSED");
  assert.match(decisions[0]?.reasons[0] ?? "", /score delta/);
});

test("RULES: cooldown suppresses same fingerprint", () => {
  const diff = baseDiff({
    overallChange: { previous: 30, current: 70, delta: 40, direction: "INCREASED" }
  });
  const candidates = evaluateThreats(diff, "wallet");
  const fp = candidates[0]?.fingerprint ?? "";
  const decisions = applyRules(candidates, rules(), {
    recentSameFingerprint: { fingerprint: fp, delta: 0 }
  });
  assert.equal(decisions[0]?.action, "SUPPRESSED");
  assert.match(decisions[0]?.reasons[0] ?? "", /cooldown/);
});

test("RULES: hysteresis suppresses repeated equal increase", () => {
  // The same PRIVACY_EXPOSURE_INCREASED event was seen before (same
  // fingerprint, delta 40) and it is OUTSIDE the cooldown window, so cooldown
  // does not fire — but a repeated +40 is oscillation → hysteresis suppresses.
  const diff = baseDiff({
    overallChange: { previous: 30, current: 70, delta: 40, direction: "INCREASED" }
  });
  const candidates = evaluateThreats(diff, "wallet");
  const fp = candidates[0]?.fingerprint ?? "";
  const decisions = applyRules(candidates, rules(), {
    recentSameFingerprint: null,
    lastEventDelta: { fingerprint: fp, delta: 40 }
  });
  assert.equal(decisions[0]?.action, "SUPPRESSED");
  assert.match(decisions[0]?.reasons[0] ?? "", /hysteresis/);
});

test("RULES: hysteresis allows a larger increase after a smaller one", () => {
  const diff = baseDiff({
    overallChange: { previous: 30, current: 70, delta: 40, direction: "INCREASED" }
  });
  const candidates = evaluateThreats(diff, "wallet");
  const fp = candidates[0]?.fingerprint ?? "";
  const decisions = applyRules(candidates, rules(), {
    recentSameFingerprint: null,
    lastEventDelta: { fingerprint: fp, delta: 10 }
  });
  assert.equal(decisions[0]?.action, "NOTIFY");
});

test("RULES: notify flags suppress entity and behavior events", () => {
  const diff = baseDiff({
    entityChanges: [{ entityName: "Coinbase", entityType: "CENTRALIZED_EXCHANGE", change: "NEW_ENTITY_EXPOSURE", previous: null, current: { count: 1, confidence: 0.9 } }]
  });
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, rules({ notifyNewEntity: false }), {});
  assert.equal(decisions[0]?.action, "SUPPRESSED");
  assert.match(decisions[0]?.reasons[0] ?? "", /notifyNewEntity/);
});

test("severityAtLeast ordering", () => {
  assert.equal(severityAtLeast("HIGH", "MEDIUM"), true);
  assert.equal(severityAtLeast("MEDIUM", "HIGH"), false);
  assert.equal(severityAtLeast("CRITICAL", "CRITICAL"), true);
});

test("FINGERPRINT: stable and distinct", () => {
  const a = eventFingerprint("m1", "NEW_ENTITY_EXPOSURE", "Coinbase");
  const b = eventFingerprint("m1", "NEW_ENTITY_EXPOSURE", "Coinbase");
  const c = eventFingerprint("m1", "NEW_ENTITY_EXPOSURE", "Binance");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});
