import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExposureDiff,
  diffScores,
  diffSignals,
  diffEntities,
  diffRelationships,
  diffAttackPaths,
  assessDataQualityChange,
  computeComparability,
  signalIdentityKeyForRow,
  type DiffInputs
} from "./index.js";
import type { AnalysisJobRow, PathRow, ScoreRow, SignalRow } from "@aegix/database";

function signal(overrides: Partial<SignalRow> & { signal_type: string }): SignalRow {
  return {
    id: "1",
    analysis_id: "a",
    wallet_id: "w",
    category: "FUNDING",
    severity: 50,
    confidence: 0.7,
    title: "",
    summary: null,
    evidence_json: [],
    source_engine: null,
    engine_version: "v1",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function score(overrides: Partial<ScoreRow>): ScoreRow {
  return {
    id: "1",
    analysis_id: "a",
    wallet_id: "w",
    overall_score: 30,
    identity_linkability: 10,
    funding_exposure: 10,
    wallet_cluster_exposure: 10,
    behavioral_fingerprint: 10,
    counterparty_exposure: 10,
    entity_exposure: 10,
    transaction_pattern_exposure: 10,
    overall_confidence: 0.7,
    scoring_version: "score-v1.0.0",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function job(overrides: Partial<AnalysisJobRow>): AnalysisJobRow {
  return {
    id: "j",
    wallet_id: "w",
    requested_by: null,
    analysis_type: "full",
    status: "READY",
    priority: "standard",
    progress: 100,
    engine_version: "aegix-pipeline-v1.0.0",
    requested_at: "2026-01-01T00:00:00Z",
    started_at: null,
    completed_at: "2026-01-01T00:00:00Z",
    failed_at: null,
    failure_code: null,
    failure_message: null,
    chain_data_until: null,
    fresh_until: null,
    data_quality: null,
    ...overrides
  };
}

function path(overrides: Partial<PathRow>): PathRow {
  return {
    id: "p",
    analysis_id: "a",
    target_wallet_id: "w",
    rank: 1,
    path_type: "ATTRIBUTION",
    nodes_json: [{ type: "WALLET", label: "target" }, { type: "ENTITY", label: "Exchange" }],
    edges_json: [],
    path_score: 0.3,
    confidence_score: 0.7,
    summary: null,
    engine_version: "graph-v1.0.0",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function inputs(overrides: Partial<DiffInputs>): DiffInputs {
  return {
    monitorId: "m1",
    previousAnalysisId: "prev",
    currentAnalysisId: "curr",
    previousJob: job({ id: "prev" }),
    currentJob: job({ id: "curr" }),
    previousScore: score({ analysis_id: "prev", overall_score: 30 }),
    currentScore: score({ analysis_id: "curr", overall_score: 30 }),
    previousSignals: [],
    currentSignals: [],
    previousPaths: [],
    currentPaths: [],
    ...overrides
  };
}

test("NO_CHANGE: semantically equivalent analyses produce no threat-relevant diff", () => {
  const s1 = signal({ signal_type: "REPEATED_FUNDING", severity: 60, confidence: 0.8 });
  const s2 = signal({ signal_type: "REPEATED_FUNDING", severity: 60, confidence: 0.8, id: "2" });
  const diff = buildExposureDiff(inputs({
    previousScore: score({ overall_score: 30 }),
    currentScore: score({ overall_score: 30 }),
    previousSignals: [s1],
    currentSignals: [s2]
  }));

  assert.equal(diff.overallChange.direction, "UNCHANGED");
  assert.equal(diff.overallChange.delta, 0);
  assert.equal(diff.newSignals.length, 0);
  assert.equal(diff.removedSignals.length, 0);
  assert.equal(diff.changedSignals.length, 0);
  assert.equal(diff.entityChanges.length, 0);
  assert.equal(diff.attackPathChanges.length, 0);
});

test("SMALL_SCORE_CHANGE: +5 is below the materiality threshold", () => {
  const diff = buildExposureDiff(inputs({
    previousScore: score({ overall_score: 30 }),
    currentScore: score({ overall_score: 35 })
  }));
  assert.equal(diff.overallChange.delta, 5);
  assert.equal(diff.overallChange.direction, "INCREASED");
});

test("MAJOR_SCORE_INCREASE: +37 is captured with direction and delta", () => {
  const diff = buildExposureDiff(inputs({
    previousScore: score({ overall_score: 24, funding_exposure: 24 }),
    currentScore: score({ overall_score: 61, funding_exposure: 61 })
  }));
  assert.equal(diff.overallChange.delta, 37);
  assert.equal(diff.overallChange.direction, "INCREASED");
  const funding = diff.dimensionChanges.find((d) => d.key === "fundingExposure");
  assert.equal(funding?.change.delta, 37);
  assert.equal(funding?.change.direction, "INCREASED");
});

test("NEW_ENTITY: entity interaction appears in current analysis", () => {
  // Previous: Binance only. Current: Binance + Coinbase (separate signals).
  const prev = signal({
    signal_type: "KNOWN_ENTITY_INTERACTION",
    category: "ENTITY",
    evidence_json: [{ key: "entity", value: "Binance", label: "entity" }]
  });
  const currBinance = signal({
    signal_type: "KNOWN_ENTITY_INTERACTION",
    category: "ENTITY",
    id: "2",
    evidence_json: [{ key: "entity", value: "Binance", label: "entity" }]
  });
  const currCoinbase = signal({
    signal_type: "KNOWN_ENTITY_INTERACTION",
    category: "ENTITY",
    id: "3",
    evidence_json: [{ key: "entity", value: "Coinbase", label: "entity" }]
  });
  const diff = buildExposureDiff(inputs({
    previousSignals: [prev],
    currentSignals: [currBinance, currCoinbase]
  }));
  const newEntity = diff.entityChanges.find((e) => e.change === "NEW_ENTITY_EXPOSURE");
  assert.ok(newEntity, "expected a new entity exposure change");
  assert.equal(newEntity?.entityName, "Coinbase");
});

test("NEW_REPEATED_FUNDER: repeated funding relationship detected", () => {
  const curr = signal({
    signal_type: "REPEATED_FUNDING",
    category: "FUNDING",
    evidence_json: [
      { key: "counterparty", value: "FunderA", label: "counterparty" },
      { key: "count", value: 6, label: "count" }
    ]
  });
  const diff = buildExposureDiff(inputs({ currentSignals: [curr] }));
  const rel = diff.relationshipChanges.find((r) => r.change === "NEW_REPEATED_COUNTERPARTY");
  assert.ok(rel, "expected new repeated counterparty");
  assert.equal(rel?.counterparty, "FunderA");
});

test("NEW_ATTACK_PATH: new path detected; reorder is not a change", () => {
  // Two distinct paths in current (target→Exchange, target→Funder), none before.
  const p1 = path({ id: "p1", path_score: 0.3 });
  const p2 = path({ id: "p2", path_score: 0.3, nodes_json: [{ type: "WALLET", label: "target" }, { type: "WALLET", label: "Funder" }] });
  const diff = buildExposureDiff(inputs({ previousPaths: [], currentPaths: [p1, p2] }));
  assert.equal(diff.attackPathChanges.filter((a) => a.change === "NEW_EXPOSURE_PATH").length, 2);

  // Same nodes in different order → same identity → no change.
  const reordered = path({ id: "p3", path_score: 0.3, nodes_json: [{ type: "ENTITY", label: "Exchange" }, { type: "WALLET", label: "target" }] });
  const diff2 = buildExposureDiff(inputs({
    previousPaths: [path({ nodes_json: [{ type: "WALLET", label: "target" }, { type: "ENTITY", label: "Exchange" }] })],
    currentPaths: [reordered]
  }));
  assert.equal(diff2.attackPathChanges.length, 0);
});

test("DATA_QUALITY_DROP: coverage drop is flagged, not read as exposure reduction", () => {
  const prevJob = job({ id: "prev", data_quality: { dataQualityScore: 80, semanticCoverage: 70 } });
  const currJob = job({ id: "curr", data_quality: { dataQualityScore: 40, semanticCoverage: 22 } });
  const dq = assessDataQualityChange(prevJob, currJob);
  assert.equal(dq.degraded, true);
  assert.equal(dq.material, true);
  assert.equal(dq.previous?.semanticCoverage, 70);
  assert.equal(dq.current.semanticCoverage, 22);
});

test("ENGINE_VERSION_CHANGE: comparability detects version drift", () => {
  const prevJob = job({ id: "prev", engine_version: "aegix-pipeline-v1.0.0" });
  const currJob = job({ id: "curr", engine_version: "aegix-pipeline-v2.0.0" });
  const cmp = computeComparability(prevJob, currJob, score({}), score({}));
  assert.equal(cmp.comparable, false);
  assert.equal(cmp.engineVersionChanged, true);
});

test("SIGNAL_IDENTITY: semantic identity ignores row id", () => {
  const s1 = signal({ signal_type: "REPEATED_FUNDING", evidence_json: [{ key: "counterparty", value: "A" }] });
  const s2 = signal({ signal_type: "REPEATED_FUNDING", id: "999", evidence_json: [{ key: "counterparty", value: "A" }] });
  assert.equal(signalIdentityKeyForRow(s1), signalIdentityKeyForRow(s2));
  // Changed confidence keeps the same identity → CHANGED, not NEW.
  const s3 = signal({ signal_type: "REPEATED_FUNDING", id: "999", confidence: 0.9, evidence_json: [{ key: "counterparty", value: "A" }] });
  const { changedSignals, newSignals } = diffSignals([s1], [s3]);
  assert.equal(changedSignals.length, 1);
  assert.equal(newSignals.length, 0);
});

test("DIFF_CONFIDENCE: version drift halves diff confidence", () => {
  const prevJob = job({ id: "prev", engine_version: "aegix-pipeline-v1.0.0" });
  const currJob = job({ id: "curr", engine_version: "aegix-pipeline-v2.0.0" });
  const diff = buildExposureDiff(inputs({
    previousJob: prevJob,
    currentJob: currJob,
    previousSignals: [signal({ signal_type: "REPEATED_FUNDING" })],
    currentSignals: []
  }));
  const comparableDiff = buildExposureDiff(inputs({
    previousSignals: [signal({ signal_type: "REPEATED_FUNDING" })],
    currentSignals: []
  }));
  assert.ok(diff.confidence < comparableDiff.confidence, "version drift must reduce confidence");
});

test("ATTACK_PATH_STRENGTHENED: stronger path detected, reorder alone is not", () => {
  const prev = path({ id: "p1", path_score: 0.3 });
  const curr = path({ id: "p1", path_score: 0.6 });
  const diff = buildExposureDiff(inputs({ previousPaths: [prev], currentPaths: [curr] }));
  assert.equal(diff.attackPathChanges.length, 1);
  assert.equal(diff.attackPathChanges[0]?.change, "STRONGER_EXPOSURE_PATH");
});
