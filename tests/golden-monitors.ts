/**
 * Golden monitor regression tests, see docs/milestone-d4.md (D4-J §95-§99).
 *
 * Deterministic offline harness: builds synthetic analysis fixtures, runs the
 * diff → threat → rules pipeline without any RPC, and asserts the golden
 * cases. Requires a local Postgres (docker compose) — the pipeline persists
 * diffs/events/notifications.
 *
 * Run: pnpm test:monitors
 */

import { createDb } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createLogger } from "@aegix/logging";
import { createQueues } from "@aegix/queue";
import { buildExposureDiff, type DiffInputs } from "@aegix/diff";
import { evaluateThreats, applyRules } from "@aegix/monitor";
import type { AnalysisJobRow, PathRow, ScoreRow, SignalRow } from "@aegix/database";
import type { MonitorAlertRules, ExposureDiff } from "@aegix/types";

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const logger = createLogger(config, { service: "golden-monitors" });
const queues = createQueues(config);

let pass = 0;
let fail = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`✔ ${name}`);
  } else {
    fail += 1;
    console.log(`✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- Fixtures ----

function signal(overrides: Partial<SignalRow> & { signal_type: string }): SignalRow {
  return {
    id: String(Math.random()),
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
    created_at: new Date().toISOString(),
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
    created_at: new Date().toISOString(),
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
    requested_at: new Date().toISOString(),
    started_at: null,
    completed_at: new Date().toISOString(),
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
    created_at: new Date().toISOString(),
    ...overrides
  };
}

const defaultRules: MonitorAlertRules = {
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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function baseInputs(overrides: Partial<DiffInputs>): DiffInputs {
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

// ---- Golden cases ----

console.log("\n=== Golden monitor cases ===\n");

async function main(): Promise<void> {
// 1. NO_CHANGE
{
  const s = signal({ signal_type: "REPEATED_FUNDING", severity: 60, confidence: 0.8 });
  const diff = buildExposureDiff(baseInputs({
    previousSignals: [s],
    currentSignals: [signal({ signal_type: "REPEATED_FUNDING", severity: 60, confidence: 0.8 })]
  }));
  const candidates = evaluateThreats(diff, "wallet");
  ok("NO_CHANGE produces no threat event", candidates.length === 0);
}

// 2. SMALL_SCORE_CHANGE (+5 → below materiality)
{
  const diff = buildExposureDiff(baseInputs({
    previousScore: score({ overall_score: 30 }),
    currentScore: score({ overall_score: 35 })
  }));
  const candidates = evaluateThreats(diff, "wallet");
  ok("SMALL_SCORE_CHANGE produces no event (below threshold)", candidates.length === 0);
}

// 3. MAJOR_SCORE_INCREASE (+37 → HIGH event)
{
  const diff = buildExposureDiff(baseInputs({
    previousScore: score({ overall_score: 24 }),
    currentScore: score({ overall_score: 61 })
  }));
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, defaultRules, {});
  ok("MAJOR_SCORE_INCREASE produces PRIVACY_EXPOSURE_INCREASED",
    decisions.some((d) => d.action === "NOTIFY" && d.event.eventType === "PRIVACY_EXPOSURE_INCREASED" && d.event.severity === "HIGH"));
}

// 4. NEW_ENTITY
{
  const diff = buildExposureDiff(baseInputs({
    currentSignals: [signal({
      signal_type: "KNOWN_ENTITY_INTERACTION",
      category: "ENTITY",
      evidence_json: [
        { key: "entity", value: "Coinbase", label: "Entity" },
        { key: "entity_type", value: "CENTRALIZED_EXCHANGE", label: "Type" },
        { key: "interaction_count", value: 3, label: "Interactions" }
      ]
    })]
  }));
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, defaultRules, {});
  ok("NEW_ENTITY produces NEW_ENTITY_EXPOSURE (HIGH for exchange)",
    decisions.some((d) => d.action === "NOTIFY" && d.event.eventType === "NEW_ENTITY_EXPOSURE" && d.event.severity === "HIGH"));
}

// 5. NEW_REPEATED_FUNDER
{
  const diff = buildExposureDiff(baseInputs({
    currentSignals: [signal({
      signal_type: "REPEATED_FUNDING",
      evidence_json: [
        { key: "counterparty", value: "FunderA", label: "counterparty" },
        { key: "count", value: 6, label: "count" }
      ]
    })]
  }));
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, defaultRules, {});
  ok("NEW_REPEATED_FUNDER produces event (HIGH for >=5 txs)",
    decisions.some((d) => d.action === "NOTIFY" && d.event.eventType === "NEW_REPEATED_FUNDER" && d.event.severity === "HIGH"));
}

// 6. NEW_ATTACK_PATH
{
  const diff = buildExposureDiff(baseInputs({
    currentPaths: [path({ path_score: 0.6 })]
  }));
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, defaultRules, {});
  ok("NEW_ATTACK_PATH produces event (HIGH for strong path)",
    decisions.some((d) => d.action === "NOTIFY" && d.event.eventType === "NEW_ATTACK_PATH" && d.event.severity === "HIGH"));
}

// 7. DATA_QUALITY_DROP → DATA_QUALITY_DEGRADED, never "exposure dropped"
{
  const diff = buildExposureDiff(baseInputs({
    previousJob: job({ id: "prev", data_quality: { dataQualityScore: 80, semanticCoverage: 70 } }),
    currentJob: job({ id: "curr", data_quality: { dataQualityScore: 40, semanticCoverage: 22 } }),
    previousScore: score({ overall_score: 61 }),
    currentScore: score({ overall_score: 30 })
  }));
  const candidates = evaluateThreats(diff, "wallet");
  const decisions = applyRules(candidates, defaultRules, {});
  ok("DATA_QUALITY_DROP emits DATA_QUALITY_DEGRADED only (no false exposure reduction)",
    candidates.length === 1 && candidates[0]?.eventType === "DATA_QUALITY_DEGRADED"
    && decisions.some((d) => d.action === "NOTIFY" && d.event.eventType === "DATA_QUALITY_DEGRADED"));
}

// 8. ENGINE_VERSION_CHANGE → no score-based alert
{
  const diff = buildExposureDiff(baseInputs({
    previousJob: job({ id: "prev", engine_version: "aegix-pipeline-v1.0.0" }),
    currentJob: job({ id: "curr", engine_version: "aegix-pipeline-v2.0.0" }),
    previousScore: score({ overall_score: 24 }),
    currentScore: score({ overall_score: 61 })
  }));
  const candidates = evaluateThreats(diff, "wallet");
  ok("ENGINE_VERSION_CHANGE suppresses score-based alerts",
    !candidates.some((c) => c.eventType === "PRIVACY_EXPOSURE_INCREASED" || c.eventType === "IDENTITY_LINKABILITY_INCREASED"));
}

// 9. DUPLICATE_EVENT: same diff → same fingerprint → cooldown suppresses
{
  const diff = buildExposureDiff(baseInputs({
    previousScore: score({ overall_score: 24 }),
    currentScore: score({ overall_score: 61 })
  }));
  const candidates = evaluateThreats(diff, "wallet");
  const fp = candidates[0]?.fingerprint ?? "";
  const first = applyRules(candidates, defaultRules, {});
  const second = applyRules(candidates, defaultRules, {
    recentSameFingerprint: { fingerprint: fp, delta: 0 }
  });
  ok("DUPLICATE_EVENT: first delivery notifies, second is suppressed by cooldown",
    first.some((d) => d.action === "NOTIFY") && second.every((d) => d.action === "SUPPRESSED"));
}

// ---- Cleanup ----

await queues.close();
await sql.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}

void main();
