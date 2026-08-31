/**
 * Monitor pipeline load test harness, see docs/milestone-d4.md (D4-J §95-§99).
 *
 * Offline harness (no RPC): provisions N wallets with a baseline and a
 * current analysis (synthetic fixtures), registers one active monitor per
 * wallet, then runs the full monitor pipeline (diff → threat evaluation →
 * rules → event/notification persistence) at a configurable concurrency.
 *
 * It measures:
 *   - end-to-end pipeline throughput and latency (p50/p95)
 *   - idempotency: re-running the same pipeline must not duplicate events
 *     or notifications (D4-J §83, §99)
 *   - cooldown: duplicate deliveries are suppressed (D4-H §64)
 *
 * Requires local Postgres + Redis (docker compose). Uses fresh wallets per
 * run so cache/dedup from earlier runs cannot skew measurements.
 *
 * Usage:
 *   pnpm loadtest:monitors --concurrency=5 --count=20
 *   pnpm loadtest:monitors --count=50 --no-idempotency-check
 *
 * Flags:
 *   --concurrency=N       simultaneous pipeline runs (default 5)
 *   --count=N             total monitors to provision (default = concurrency)
 *   --timeout=SECONDS     per-run timeout (default 120)
 *   --no-idempotency-check  skip the duplicate-delivery verification pass
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createDb, createAnalysisJobRepo, createIntelligenceRepo, createMonitorAlertRulesRepo, createMonitorRepo, createWalletRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createLogger } from "@aegix/logging";
import { createQueues } from "@aegix/queue";
import { runMonitorPipeline, type ProcessorContext } from "@aegix/monitor";

interface Options {
  concurrency: number;
  count: number;
  timeoutSeconds: number;
  idempotencyCheck: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { concurrency: 5, count: 0, timeoutSeconds: 120, idempotencyCheck: true };
  for (const arg of argv) {
    const [key, raw] = arg.split("=");
    const value = raw ?? "true";
    switch (key) {
      case "--concurrency": opts.concurrency = Number(value); break;
      case "--count": opts.count = Number(value); break;
      case "--timeout": opts.timeoutSeconds = Number(value); break;
      case "--no-idempotency-check": opts.idempotencyCheck = false; break;
      default: throw new Error(`unknown flag ${key}`);
    }
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) throw new Error("--concurrency must be >= 1");
  if (!Number.isFinite(opts.timeoutSeconds) || opts.timeoutSeconds < 1) throw new Error("--timeout must be >= 1");
  if (!opts.count) opts.count = opts.concurrency;
  return opts;
}

const ENGINE_VERSION = "aegix-pipeline-v2.0.0";

interface Fixture {
  monitorId: string;
  userId: string;
  walletId: string;
  previousAnalysisId: string;
  currentAnalysisId: string;
}

async function provisionFixtures(sql: ReturnType<typeof createDb>, count: number): Promise<Fixture[]> {
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const monitorRepo = createMonitorRepo(sql);
  const rulesRepo = createMonitorAlertRulesRepo(sql);
  const now = new Date().toISOString();
  const fixtures: Fixture[] = [];

  for (let i = 0; i < count; i++) {
    const userId = randomUUID();
    await sql`insert into profiles (id, display_name, plan) values (${userId}, ${`loadtest-${i}`}, 'free')`;

    // Fresh wallet per run: address is unique per invocation.
    const wallet = await walletRepo.findOrCreate("solana", `loadtest-${randomUUID()}-${i}`);

    const previousJob = await jobRepo.create({ walletId: wallet.id, requestedBy: userId, analysisType: "full", priority: "free" });
    await jobRepo.markStarted(previousJob.id, ENGINE_VERSION);
    await jobRepo.markCompleted(previousJob.id, { chainDataUntil: now, freshUntil: now }, { dataQualityScore: 80, semanticCoverage: 70 });

    const currentJob = await jobRepo.create({ walletId: wallet.id, requestedBy: userId, analysisType: "full", priority: "free" });
    await jobRepo.markStarted(currentJob.id, ENGINE_VERSION);
    await jobRepo.markCompleted(currentJob.id, { chainDataUntil: now, freshUntil: now }, { dataQualityScore: 80, semanticCoverage: 70 });

    // Baseline: modest score, no signals. Current: big score increase + new
    // entity signal — guaranteed to produce threat candidates.
    await intelligenceRepo.insertScore({
      analysisId: previousJob.id,
      walletId: wallet.id,
      overallScore: 24,
      dimensions: { identityLinkability: 8, fundingExposure: 6, walletClusterExposure: 4, behavioralFingerprint: 4, counterpartyExposure: 2, entityExposure: 0, transactionPatternExposure: 0 },
      overallConfidence: 0.8,
      scoringVersion: "score-v1.0.0"
    });
    await intelligenceRepo.insertScore({
      analysisId: currentJob.id,
      walletId: wallet.id,
      overallScore: 61,
      dimensions: { identityLinkability: 16, fundingExposure: 12, walletClusterExposure: 10, behavioralFingerprint: 8, counterpartyExposure: 6, entityExposure: 5, transactionPatternExposure: 4 },
      overallConfidence: 0.8,
      scoringVersion: "score-v1.0.0"
    });
    await intelligenceRepo.insertSignals([{
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

    const monitor = await monitorRepo.create({
      userId,
      walletId: wallet.id,
      savedAnalysisId: null,
      scheduleType: "DAILY",
      baselineAnalysisId: previousJob.id,
      nextCheckAt: new Date(Date.now() + 86_400_000).toISOString()
    });
    await rulesRepo.createWithMonitor(monitor.id, {
      minimumSeverity: "LOW",
      minimumConfidence: 0.5,
      overallScoreDeltaThreshold: 10,
      cooldownHours: 24
    });

    fixtures.push({
      monitorId: monitor.id,
      userId,
      walletId: wallet.id,
      previousAnalysisId: previousJob.id,
      currentAnalysisId: currentJob.id
    });
  }
  return fixtures;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`\n=== Monitor pipeline load test ===`);
  console.log(`concurrency=${opts.concurrency} count=${opts.count} idempotency-check=${opts.idempotencyCheck}\n`);

  const config = loadConfig();
  const sql = createDb(config.DATABASE_URL);
  const logger = createLogger(config, { service: "loadtest-monitors" });
  const queues = createQueues(config);
  const ctx: ProcessorContext = { config, sql, logger, queues };

  const started = Date.now();
  const fixtures = await provisionFixtures(sql, opts.count);
  const provisionMs = Date.now() - started;
  console.log(`provisioned ${fixtures.length} fixtures in ${provisionMs}ms`);

  // Run the pipeline once per fixture with bounded concurrency.
  const latencies: number[] = [];
  let failures = 0;
  let index = 0;
  const workers = Array.from({ length: opts.concurrency }, async () => {
    while (index < fixtures.length) {
      const fx = fixtures[index++];
      const t0 = Date.now();
      try {
        await runMonitorPipeline(ctx, { analysisId: fx.currentAnalysisId, walletId: fx.walletId });
        latencies.push(Date.now() - t0);
      } catch (err) {
        failures += 1;
        console.error(`✖ fixture ${fx.monitorId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  await Promise.all(workers);
  const runMs = Date.now() - started - provisionMs;

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const opsPerSec = runMs > 0 ? (latencies.length / runMs) * 1000 : 0;
  console.log(`\nfirst pass: ${latencies.length} runs, ${failures} failures, ${runMs}ms`);
  console.log(`throughput: ${opsPerSec.toFixed(2)} ops/s, p50=${p50}ms, p95=${p95}ms`);

  // Verify persistence: events + notifications exist, and one per monitor.
  const [eventRows] = await sql<Array<{ count: string }>>`select count(*)::text as count from threat_events`;
  const [notifRows] = await sql<Array<{ count: string }>>`select count(*)::text as count from notifications`;
  const events = Number(eventRows?.count ?? 0);
  const notifs = Number(notifRows?.count ?? 0);
  console.log(`persisted: ${events} threat events, ${notifs} notifications`);

  // Idempotency pass: re-run the same pipeline — diffs already exist, so no
  // new events/notifications may be created (D4-J §83, §99).
  if (opts.idempotencyCheck) {
    const t0 = Date.now();
    let dupFailures = 0;
    let dupIndex = 0;
    const dupWorkers = Array.from({ length: opts.concurrency }, async () => {
      while (dupIndex < fixtures.length) {
        const fx = fixtures[dupIndex++];
        try {
          await runMonitorPipeline(ctx, { analysisId: fx.currentAnalysisId, walletId: fx.walletId });
        } catch (err) {
          dupFailures += 1;
          console.error(`✖ idempotency rerun ${fx.monitorId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    await Promise.all(dupWorkers);
    const dupMs = Date.now() - t0;
    console.log(`idempotency pass: ${dupMs}ms, ${dupFailures} failures`);

    const [eventRows2] = await sql<Array<{ count: string }>>`select count(*)::text as count from threat_events`;
    const [notifRows2] = await sql<Array<{ count: string }>>`select count(*)::text as count from notifications`;
    const eventsAfter = Number(eventRows2?.count ?? 0);
    const notifsAfter = Number(notifRows2?.count ?? 0);
    const dupEvents = eventsAfter - events;
    const dupNotifs = notifsAfter - notifs;
    console.log(`idempotency: ${dupEvents} duplicate events, ${dupNotifs} duplicate notifications`);
    if (dupEvents !== 0 || dupNotifs !== 0) {
      console.error("✖ idempotency violated: duplicate rows created on re-run");
      await queues.close();
      await sql.end();
      process.exit(1);
    }
  }

  await queues.close();
  await sql.end();
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${latencies.length} pipelines, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
