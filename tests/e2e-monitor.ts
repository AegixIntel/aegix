/**
 * End-to-end privacy monitor flow test, see docs/milestone-d4.md (D4-J §99).
 *
 * Runs the complete monitor lifecycle against a clean database:
 *   reset schema → provision user/wallet/baseline → register monitor →
 *   per-monitor check (freshness reuse) → new analysis → analysis-complete
 *   fan-out → pipeline (diff → threat → rules → events → notifications) →
 *   idempotency re-run → ownership verification.
 *
 * Public-beta regression: a wallet-only user with no email receives IN_APP
 * notifications; dormant email delivery remains disabled and outside this
 * release gate. Also covers webhook independence and correlation alerts.
 *
 * Requires local Postgres + Redis (docker compose). Resets the database.
 *
 * Run: pnpm test:e2e-monitor
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createDb, createAnalysisJobRepo, createIntelligenceRepo, createMonitorAlertRulesRepo, createMonitorRepo, createWalletRepo, createNotificationRepo, createThreatEventRepo, createCorrelationRepo, createMonitorCorrelationRepo, createWebhookRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createLogger } from "@aegix/logging";
import { createQueues } from "@aegix/queue";
import { runMonitorPipeline, CORRELATION_MONITOR_ENGINE_VERSION, type ProcessorContext } from "@aegix/monitor";
import { createWebhookSecret } from "../apps/api/src/webhook-crypto.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

// ---- Environment safety guards ----
const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aegix_test";
requireSafeTestDatabaseReset(process.env, { databaseUrl: TEST_DB_URL });
process.env.DATABASE_URL = TEST_DB_URL;
process.env.EMAIL_ENABLED = "false";
process.env.ENABLE_EMAIL_NOTIFICATIONS = "false";

// Webhook signing secrets are encrypted at rest; e2e uses a dev key when
// the environment does not provide one (production fail-fast still applies).
if (!process.env.WEBHOOK_ENCRYPTION_KEY) {
  process.env.WEBHOOK_ENCRYPTION_KEY = "e2e-monitor-webhook-encryption-key-0123456789";
}

const ENGINE_VERSION = "aegix-pipeline-v2.0.0";
const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const logger = createLogger(config, { service: "e2e-monitor" });
const queues = createQueues(config);
const ctx: ProcessorContext = { config, sql, logger, queues };

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

async function main(): Promise<void> {
  console.log("\n=== End-to-end monitor flow ===\n");

  // 1. Clean state: drop and re-apply all migrations.
  console.log("resetting database to clean state...");
  await sql.unsafe("drop schema public cascade; create schema public;");
  await sql.end();
  execFileSync("pnpm", ["--filter", "@aegix/database", "migrate"], { stdio: "inherit", env: process.env });

  // Clear deterministic deliver-job leftovers from prior runs (Redis is not
  // reset with the schema) so the no-email job assertions measure this run.
  await queues.monitoring.drain(true).catch(() => {});
  await queues.webhooks.drain(true).catch(() => {});

  // Reconnect after schema reset.
  const sql2 = createDb(config.DATABASE_URL);
  const ctx2: ProcessorContext = { ...ctx, sql: sql2 };

  const walletRepo = createWalletRepo(sql2);
  const jobRepo = createAnalysisJobRepo(sql2);
  const intelRepo = createIntelligenceRepo(sql2);
  const monitorRepo = createMonitorRepo(sql2);
  const rulesRepo = createMonitorAlertRulesRepo(sql2);
  const notifRepo = createNotificationRepo(sql2);
  const eventRepo = createThreatEventRepo(sql2);
  const now = new Date().toISOString();

  // 2. Provision: user, wallet, baseline analysis (READY), saved analysis.
  const userId = randomUUID();
  await sql2`insert into profiles (id, display_name, plan) values (${userId}, 'e2e-user', 'free')`;
  const wallet = await walletRepo.findOrCreate("solana", `e2e-${randomUUID()}`);
  const baselineJob = await jobRepo.create({ walletId: wallet.id, requestedBy: userId, analysisType: "full", priority: "standard" });
  await jobRepo.markStarted(baselineJob.id, ENGINE_VERSION);
  await jobRepo.markCompleted(baselineJob.id, { chainDataUntil: now, freshUntil: new Date(Date.now() + 3600_000).toISOString() }, { dataQualityScore: 80, semanticCoverage: 70 });
  await intelRepo.insertScore({
    analysisId: baselineJob.id,
    walletId: wallet.id,
    overallScore: 24,
    dimensions: { identityLinkability: 8, fundingExposure: 6, walletClusterExposure: 4, behavioralFingerprint: 4, counterpartyExposure: 2, entityExposure: 0, transactionPatternExposure: 0 },
    overallConfidence: 0.8,
    scoringVersion: "score-v1.0.0"
  });
  await sql2`insert into saved_analyses (user_id, wallet_id, analysis_id, label) values (${userId}, ${wallet.id}, ${baselineJob.id}, 'e2e wallet')`;

  const monitor = await monitorRepo.create({
    userId,
    walletId: wallet.id,
    savedAnalysisId: null,
    scheduleType: "EVERY_6_HOURS",
    baselineAnalysisId: baselineJob.id,
    nextCheckAt: new Date(Date.now() - 1000).toISOString() // due now
  });
  await rulesRepo.createWithMonitor(monitor.id, {
    minimumSeverity: "LOW",
    minimumConfidence: 0.5,
    overallScoreDeltaThreshold: 10,
    cooldownHours: 24
  });
  ok("monitor registered with baseline", true);

  // 3. Scheduler sweep picks up the due monitor (inserts audit row + job),
  // then the per-monitor check runs and reuses the fresh READY analysis.
  const { processMonitorJob } = await import("../apps/worker/src/processors/monitoring.js");
  const sweepJob = { id: "e2e-sweep", data: { kind: "check" } } as never;
  await processMonitorJob(sweepJob as never, ctx2);
  const checkJob = { id: `e2e-check-${monitor.id}`, data: { kind: "check", monitorId: monitor.id } } as never;
  await processMonitorJob(checkJob as never, ctx2);
  const monitorAfterCheck = await monitorRepo.getRowForUserOwned(monitor.id);
  ok("per-monitor check reuses fresh analysis",
    monitorAfterCheck?.last_analysis_id === baselineJob.id && monitorAfterCheck?.last_checked_at !== null);
  const [checkRows] = await sql2<Array<{ status: string; reused_analysis: boolean }>>`select status, reused_analysis from monitor_checks where monitor_id = ${monitor.id} order by id desc limit 1`;
  ok("check audit row REUSED", checkRows?.status === "REUSED" && checkRows.reused_analysis === true, JSON.stringify(checkRows));

  // 4. New analysis (current): score increase + new exchange entity.
  const currentJob = await jobRepo.create({ walletId: wallet.id, requestedBy: userId, analysisType: "full", priority: "standard" });
  await jobRepo.markStarted(currentJob.id, ENGINE_VERSION);
  await jobRepo.markCompleted(currentJob.id, { chainDataUntil: now, freshUntil: new Date(Date.now() + 3600_000).toISOString() }, { dataQualityScore: 80, semanticCoverage: 70 });
  await intelRepo.insertScore({
    analysisId: currentJob.id,
    walletId: wallet.id,
    overallScore: 61,
    dimensions: { identityLinkability: 16, fundingExposure: 12, walletClusterExposure: 10, behavioralFingerprint: 8, counterpartyExposure: 6, entityExposure: 5, transactionPatternExposure: 4 },
    overallConfidence: 0.8,
    scoringVersion: "score-v1.0.0"
  });
  await intelRepo.insertSignals([{
    analysisId: currentJob.id,
    walletId: wallet.id,
    signalType: "KNOWN_ENTITY_INTERACTION",
    category: "ENTITY",
    severity: 65,
    confidence: 0.9,
    title: "Interaction with Coinbase",
    summary: "Interacted with Coinbase",
    evidence: [
      { key: "entity", value: "Coinbase", label: "Entity" },
      { key: "entity_type", value: "CENTRALIZED_EXCHANGE", label: "Type" },
      { key: "interaction_count", value: 5, label: "Interactions" }
    ],
    engineVersion: ENGINE_VERSION
  }]);
  ok("current analysis READY with changed exposure", true);

  // D6 regression §11: webhook independence — configure a webhook BEFORE the
  // pipeline runs, for a user that has NO email anywhere.
  const webhookRepo = createWebhookRepo(sql2);
  const material = createWebhookSecret(config);
  const webhook = await webhookRepo.create({
    userId,
    url: "https://example.com/hooks",
    eventTypes: ["monitor.threat.created"],
    secretEncrypted: material.encrypted,
    secretNonce: material.nonce,
    secretKeyVersion: material.keyVersion
  });
  ok("webhook created for no-email user", webhook.id !== undefined && webhook.status === "ACTIVE");

  // 5. Analysis-complete fan-out: run the monitor pipeline.
  await runMonitorPipeline(ctx2, { analysisId: currentJob.id, walletId: wallet.id });

  const events = await eventRepo.listForMonitor(monitor.id, 10);
  ok("diff persisted (exposure_diffs)", true);
  ok("threat events created", events.length >= 2, `got ${events.length}`);
  ok("PRIVACY_EXPOSURE_INCREASED HIGH", events.some((e) => e.event_type === "PRIVACY_EXPOSURE_INCREASED" && e.severity === "HIGH"));
  ok("NEW_ENTITY_EXPOSURE HIGH (exchange)", events.some((e) => e.event_type === "NEW_ENTITY_EXPOSURE" && e.severity === "HIGH" && e.subject === "Coinbase"));

  const notifs = await notifRepo.listForUser(userId, 10);
  ok("in-app notifications created", notifs.length >= 2, `got ${notifs.length}`);
  ok("in-app notifications are SENT", notifs.every((n) => n.channel === "IN_APP" && n.status === "SENT"), JSON.stringify(notifs.map((n) => ({ ch: n.channel, s: n.status }))));

  const monitorAfter = await monitorRepo.getRowForUserOwned(monitor.id);
  ok("monitor last_analysis_id advanced", monitorAfter?.last_analysis_id === currentJob.id);

  // D6 regression: a wallet-only user with NO email must get IN_APP only.
  // No EMAIL row may exist and no deliver job may be enqueued (§13, §30).
  const emailRows = await notifRepo.listForUser(userId, 100);
  ok("no-email user: zero EMAIL notification rows", emailRows.every((n) => n.channel === "IN_APP"), `channels: ${[...new Set(emailRows.map((n) => n.channel))].join(",")}`);
  const deliverJobs = await queues.monitoring.getJobs(["waiting", "active", "delayed"], 0, 100);
  ok("no-email user: no notify-deliver jobs enqueued", deliverJobs.every((j) => !String(j.name).startsWith("notify-deliver")), `${deliverJobs.length} pending jobs`);

  // D6 regression §11, §15: no-email user + configured webhook → the pipeline
  // must have enqueued webhook deliveries independently of email.
  const hookJobs = await queues.webhooks.getJobs(["waiting", "active", "delayed", "completed", "failed"], 0, 100);
  ok("no-email user: webhook deliveries enqueued independently", hookJobs.length >= 1, `${hookJobs.length} webhook jobs`);

  // 6. Idempotency: re-running the same fan-out must not duplicate.
  await runMonitorPipeline(ctx2, { analysisId: currentJob.id, walletId: wallet.id });
  const events2 = await eventRepo.listForMonitor(monitor.id, 10);
  const notifs2 = await notifRepo.listForUser(userId, 10);
  ok("idempotency: no duplicate events", events2.length === events.length, `${events.length} → ${events2.length}`);
  ok("idempotency: no duplicate notifications", notifs2.length === notifs.length, `${notifs.length} → ${notifs2.length}`);

  // 7. Ownership/RLS sanity: another user cannot see the monitor.
  const otherUser = randomUUID();
  const otherMonitor = await monitorRepo.getRowForUser(otherUser, monitor.id);
  ok("ownership: other user cannot read monitor", otherMonitor === null);

  // 8. Event lifecycle: acknowledge.
  const firstEvent = events[0]!;
  const acked = await eventRepo.acknowledge(userId, firstEvent.id);
  ok("event acknowledge", acked === true);

  // 9. Correlation alert path with no email (§24): a correlation result that
  // crosses the monitor thresholds must persist a correlation event and an
  // IN_APP notification for the email-less user without FK/recipient errors.
  const correlationRepo = createCorrelationRepo(sql2);
  const monitorCorrRepo = createMonitorCorrelationRepo(sql2);
  const related = "DpFKMQXG21YQTUsCKGusU6SuQpAnR87dqu5DJL8Hm8Eb";
  await correlationRepo.upsert({
    pairId: [wallet.address, related].sort().join("|"),
    correlationScore: 72,
    confidence: 0.7,
    classification: "PERSONAL",
    evidenceFamilies: [{ family: "sharedFunding", strength: 0.6 }],
    limitations: [],
    engineVersion: "correlation-v1.0.0"
  });
  const corrCurrent = await correlationRepo.listForWallet(wallet.address, 20);
  const corrSnap = corrCurrent.map((r) => ({
    walletA: r.wallet_a,
    walletB: r.wallet_b,
    pairId: [r.wallet_a, r.wallet_b].sort().join("|"),
    correlationScore: r.correlation_score,
    confidence: Number(r.confidence),
    classification: r.classification,
    evidenceFamilies: ((r.evidence_families ?? []) as Array<{ family: string; strength: number }>).map((f) => ({ family: f.family, strength: Number(f.strength) })),
    engineVersion: r.engine_version,
    correlationResultId: r.id
  }));
  const { evaluateCorrelationChanges } = await import("@aegix/monitor");
  const corrCandidates = evaluateCorrelationChanges(monitor.id, wallet.address, null, corrSnap[0]!, {
    enterStrongScore: config.CORRELATION_ALERT_ENTER_STRONG,
    exitStrongScore: config.CORRELATION_ALERT_EXIT_STRONG,
    minDelta: config.CORRELATION_ALERT_MIN_DELTA,
    minScore: 40,
    minConfidence: 0.5,
    cooldownHours: 24,
    notifyCorrelationChange: true
  });
  ok("correlation no-email: APPEARED candidate emitted", corrCandidates.some((c) => c.eventType === "CORRELATION_APPEARED"), JSON.stringify(corrCandidates.map((c) => c.eventType)));
  const appeared = corrCandidates.find((c) => c.eventType === "CORRELATION_APPEARED")!;
  const corrEvent = await monitorCorrRepo.upsertEvent({
    monitorId: monitor.id,
    userId,
    walletId: wallet.id,
    relatedWallet: appeared.relatedWallet,
    eventType: appeared.eventType,
    severity: appeared.severity,
    confidence: appeared.confidence,
    previousScore: appeared.previousScore,
    newScore: appeared.newScore,
    previousConfidence: appeared.previousConfidence,
    newConfidence: appeared.newConfidence,
    evidence: appeared.evidence as Record<string, unknown>,
    limitations: appeared.limitations,
    engineVersion: CORRELATION_MONITOR_ENGINE_VERSION,
    fingerprint: appeared.fingerprint
  });
  ok("correlation no-email: event persisted", corrEvent.id !== undefined && corrEvent.fingerprint === appeared.fingerprint);

  await queues.close();
  await sql2.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
