import type { Job } from "bullmq";
import type { AppConfig } from "@aegix/config";
import {
  createAnalysisJobRepo,
  createMonitorCheckRepo,
  createMonitorRepo,
  createWalletRepo
} from "@aegix/database";
import type { MonitoringJobData } from "@aegix/queue";
import type { AegixLogger } from "@aegix/logging";
import type { ProcessorContext } from "../worker.js";

/** Interval per schedule type — must mirror the API-side mapping. */
export function monitorIntervalMs(scheduleType: string, config: AppConfig): number {
  switch (scheduleType) {
    case "EVERY_6_HOURS": return 6 * 3600_000;
    case "EVERY_12_HOURS": return 12 * 3600_000;
    case "EVERY_MINUTE": return config.MONITOR_TEST_SCHEDULES_ENABLED ? 60_000 : 24 * 3600_000;
    default: return 24 * 3600_000; // DAILY
  }
}

/**
 * Monitoring queue processor, see docs/milestone-d4.md (D4-B, D4-I §75).
 * Dispatches on job kind:
 * - "check" without monitorId: scheduler sweep — finds due monitors, enqueues
 *   one deterministic per-monitor run per schedule window.
 * - "check" with monitorId: per-monitor run — reuses a fresh READY analysis
 *   when possible, otherwise enqueues a low-priority analysis job.
 * - "diff": analysis-complete fan-out — delegates to the monitor pipeline.
 * - "deliver": notification delivery attempt.
 */
export async function processMonitorJob(job: Job<MonitoringJobData>, ctx: ProcessorContext): Promise<void> {
  const { config, logger: baseLogger } = ctx;
  const logger = baseLogger.child({ jobId: job.id, kind: job.data.kind });
  const data = job.data;

  if (data.kind === "check" && data.monitorId) {
    await runMonitorCheck(job as Job<{ kind: "check"; monitorId: string }>, ctx);
    return;
  }
  if (data.kind === "check") {
    await runSchedulerSweep(ctx, logger);
    return;
  }
  if (data.kind === "diff") {
    await runMonitorDiff(data.analysisId, data.walletId, ctx, logger);
    return;
  }
  if (data.kind === "deliver") {
    await runNotificationDelivery(data.notificationId, ctx, logger);
    return;
  }
  logger.warn("unknown monitoring job kind");
}

// ---------------------------------------------------------------------------
// Scheduler sweep
// ---------------------------------------------------------------------------

async function runSchedulerSweep(ctx: ProcessorContext, logger: AegixLogger): Promise<void> {
  const { config, sql } = ctx;

  // Kill switch: scheduler registered but monitoring disabled → no-op.
  if (!config.ENABLE_MONITORING || !config.ENABLE_MONITOR_SCHEDULER) {
    logger.debug("monitoring disabled, skipping sweep");
    return;
  }

  // Budget gates, see D4-I §71: global monitor job budget per hour.
  if (!(await withinHourlyBudget(ctx, logger))) return;

  const monitorRepo = createMonitorRepo(sql);
  const checkRepo = createMonitorCheckRepo(sql);
  const now = new Date().toISOString();
  const due = await monitorRepo.listDue(now, config.MAX_ACTIVE_MONITOR_JOBS);

  for (const monitor of due) {
    // Deterministic per-window job id: re-adding the same window is a no-op.
    const interval = monitorIntervalMs(monitor.schedule_type, config);
    const windowKey = `${monitor.id}:${Math.floor(Date.now() / interval)}`;
    const jobId = `monitor:${windowKey}`;
    try {
      await ctx.queues.monitoring.add(
        "monitor-run",
        { kind: "check", monitorId: monitor.id },
        { jobId, attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 200 }
      );
      // Audit trail: record the check BEFORE the run so delays are measurable.
      await checkRepo.insert({ monitorId: monitor.id, scheduledFor: monitor.next_check_at ?? now });
      logger.info("monitor check scheduled", { monitorId: monitor.id, walletId: monitor.wallet_id, jobId });
    } catch (err) {
      logger.error("failed to enqueue monitor check", {
        monitorId: monitor.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

async function withinHourlyBudget(ctx: ProcessorContext, logger: AegixLogger): Promise<boolean> {
  const { config, sql } = ctx;
  const [row] = await sql<Array<{ count: string }>>`
    select count(*)::text as count from monitor_checks
    where created_at > now() - interval '1 hour'
  `;
  const count = row ? Number(row.count) : 0;
  if (count >= config.MAX_MONITOR_JOBS_PER_HOUR) {
    logger.warn("monitor hourly budget reached, delaying sweep", { count, limit: config.MAX_MONITOR_JOBS_PER_HOUR });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-monitor check run
// ---------------------------------------------------------------------------

async function runMonitorCheck(job: Job<{ kind: "check"; monitorId: string }>, ctx: ProcessorContext): Promise<void> {
  const { config, sql } = ctx;
  const logger = ctx.logger.child({ jobId: job.id, monitorId: job.data.monitorId });
  const monitorRepo = createMonitorRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const walletRepo = createWalletRepo(sql);
  const checkRepo = createMonitorCheckRepo(sql);

  const monitor = await monitorRepo.getRowForUserOwned(job.data.monitorId);
  if (!monitor || monitor.status !== "ACTIVE") {
    logger.debug("monitor not active, skipping", { status: monitor?.status ?? "missing" });
    return;
  }

  const wallet = await walletRepo.findById(monitor.wallet_id);
  if (!wallet) {
    logger.error("monitor wallet missing", { monitorId: monitor.id });
    return;
  }

  // Reuse a fresh READY analysis, see D4-B §14: never spend RPC twice when a
  // user just analyzed the wallet manually. Monitor freshness is configurable
  // separately from interactive freshness (D4-B §15).
  const latest = await jobRepo.latestForWallet(monitor.wallet_id);
  const freshnessWindow = Math.max(config.MONITOR_FRESHNESS_TTL_SECONDS, config.ANALYSIS_CACHE_TTL_SECONDS);
  if (latest && latest.fresh_until && new Date(latest.fresh_until).getTime() > Date.now() - freshnessWindow * 1000) {
    const checkRow = await latestCheckRow(checkRepo, monitor.id);
    if (checkRow) await checkRepo.markCompleted(checkRow.id, { status: "REUSED", analysisId: latest.id, reused: true, previousAnalysisId: monitor.last_analysis_id });
    await monitorRepo.touchCheck(monitor.id, latest.id);
    logger.info("monitor reused fresh analysis", { monitorId: monitor.id, analysisId: latest.id });
    return;
  }

  // Enqueue a fresh low-priority analysis (interactive stays prioritized, D4-B §18).
  const analysis = await jobRepo.create({
    walletId: monitor.wallet_id,
    requestedBy: monitor.user_id,
    analysisType: "full",
    priority: "free"
  });
  const checkRow = await latestCheckRow(checkRepo, monitor.id);
  if (checkRow) await checkRepo.markCompleted(checkRow.id, { status: "IN_PROGRESS", analysisId: analysis.id, reused: false, previousAnalysisId: monitor.last_analysis_id });
  await monitorRepo.setLastAnalysis(monitor.id, analysis.id);

  const queue = ctx.queues.analysisFree;
  await queue.add(
    "analyze",
    { analysisId: analysis.id, walletAddress: wallet.address, chain: "solana", analysisType: "full" },
    { jobId: `analysis-${analysis.id}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } }
  );
  logger.info("monitor enqueued analysis", { monitorId: monitor.id, analysisId: analysis.id, walletShort: wallet.address.slice(0, 8) });
}

async function latestCheckRow(checkRepo: ReturnType<typeof createMonitorCheckRepo>, monitorId: string) {
  const rows = await checkRepo.listForMonitor(monitorId, 1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Analysis-complete fan-out (delegates to the monitor pipeline package)
// ---------------------------------------------------------------------------

async function runMonitorDiff(analysisId: string, walletId: string, ctx: ProcessorContext, logger: AegixLogger): Promise<void> {
  const { runMonitorPipeline } = await import("@aegix/monitor");
  await runMonitorPipeline(ctx, { analysisId, walletId });
}

// ---------------------------------------------------------------------------
// Notification delivery (delegates to the monitor pipeline package)
// ---------------------------------------------------------------------------

async function runNotificationDelivery(notificationId: string, ctx: ProcessorContext, logger: AegixLogger): Promise<void> {
  const { deliverNotification } = await import("@aegix/monitor");
  await deliverNotification(ctx, notificationId);
}
