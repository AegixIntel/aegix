import { createHash } from "node:crypto";
import type { AppConfig } from "@aegix/config";
import {
  createAnalysisJobRepo,
  createExposureDiffRepo,
  createIntelligenceRepo,
  createMonitorAlertRulesRepo,
  createMonitorRepo,
  createNotificationRepo,
  createThreatEventRepo,
  createWalletRepo
} from "@aegix/database";
import type { AegixQueues } from "@aegix/queue";
import type { AegixLogger } from "@aegix/logging";
import type { ProcessorContext } from "./types.js";
import { buildExposureDiff, type DiffInputs } from "@aegix/diff";
import { applyRules, evaluateThreats } from "./threat.js";
import { createEmailProvider, PermanentEmailError, type EmailProvider } from "./email.js";

/**
 * Monitor pipeline, see docs/milestone-d4.md (D4-D §34, D4-E §47, D4-I §75).
 *
 * Analysis complete → for each active monitor of the wallet:
 *   diff (idempotent) → threat evaluation → rule application (cooldown,
 *   hysteresis) → event upsert by fingerprint → notifications (in-app +
 *   email) → monitor bookkeeping.
 *
 * The diff insert is idempotent on (monitor, prev, current) and events are
 * idempotent on (monitor, fingerprint): duplicate fan-out messages cannot
 * duplicate events or notifications (D4-J §83, §99).
 */

export interface MonitorPipelineOptions {
  analysisId: string;
  walletId: string;
}

export async function runMonitorPipeline(
  ctx: ProcessorContext,
  opts: MonitorPipelineOptions
): Promise<void> {
  const { config, sql, logger: baseLogger } = ctx;
  const logger = baseLogger.child({ analysisId: opts.analysisId, walletId: opts.walletId });

  if (!config.ENABLE_MONITORING) {
    logger.debug("monitoring disabled, skipping pipeline");
    return;
  }

  const monitorRepo = createMonitorRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const walletRepo = createWalletRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const diffRepo = createExposureDiffRepo(sql);
  const eventRepo = createThreatEventRepo(sql);
  const rulesRepo = createMonitorAlertRulesRepo(sql);
  const notificationRepo = createNotificationRepo(sql);

  const currentJob = await jobRepo.findById(opts.analysisId);
  if (!currentJob || currentJob.status !== "READY") {
    logger.warn("pipeline skipped: analysis not READY", { status: currentJob?.status ?? "missing" });
    return;
  }

  const monitors = await monitorRepo.listActiveForWallet(opts.walletId);
  if (monitors.length === 0) {
    logger.debug("no active monitors for wallet");
    return;
  }
  logger.info("monitor fan-out started", { monitors: monitors.length });

  const wallet = await walletRepo.findById(opts.walletId);
  const emailProvider = createEmailProvider(config, logger);
  for (const monitor of monitors) {
    // Idempotency: this analysis already compared for this monitor.
    if (monitor.last_analysis_id === opts.analysisId) {
      logger.debug("monitor already processed this analysis", { monitorId: monitor.id });
      continue;
    }
    const previousAnalysisId = monitor.last_analysis_id ?? monitor.baseline_analysis_id;
    if (!previousAnalysisId) {
      // First observation: baseline only, nothing to compare yet.
      await monitorRepo.touchCheck(monitor.id, opts.analysisId);
      logger.info("monitor baseline set", { monitorId: monitor.id, analysisId: opts.analysisId });
      continue;
    }
    if (previousAnalysisId === opts.analysisId) continue;

    try {
      await processMonitorDiff(ctx, {
        monitorId: monitor.id,
        monitorUserId: monitor.user_id,
        previousAnalysisId,
        currentAnalysisId: opts.analysisId,
        walletAddress: wallet?.address ?? "",
        emailProvider
      });
    } catch (err) {
      // Per-monitor isolation: one failing monitor must not block the others.
      const message = err instanceof Error ? err.message : String(err);
      logger.error("monitor pipeline failed", { monitorId: monitor.id, error: message });
      await monitorRepo.setStatusById(monitor.id, "ERROR").catch(() => {});
    }
  }
}

async function processMonitorDiff(
  ctx: ProcessorContext,
  input: {
    monitorId: string;
    monitorUserId: string;
    previousAnalysisId: string;
    currentAnalysisId: string;
    walletAddress: string;
    emailProvider: EmailProvider;
  }
): Promise<void> {
  const { sql, config } = ctx;
  const jobRepo = createAnalysisJobRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);
  const diffRepo = createExposureDiffRepo(sql);
  const eventRepo = createThreatEventRepo(sql);
  const rulesRepo = createMonitorAlertRulesRepo(sql);
  const notificationRepo = createNotificationRepo(sql);
  const monitorRepo = createMonitorRepo(sql);

  // Load both analyses' persisted outputs (source of truth, D4-C).
  const [previousJob, currentJob, previousScore, currentScore, previousSignals, currentSignals, previousPaths, currentPaths] = await Promise.all([
    jobRepo.findById(input.previousAnalysisId),
    jobRepo.findById(input.currentAnalysisId),
    intelligenceRepo.scoreForAnalysis(input.previousAnalysisId),
    intelligenceRepo.scoreForAnalysis(input.currentAnalysisId),
    intelligenceRepo.signalsForAnalysis(input.previousAnalysisId),
    intelligenceRepo.signalsForAnalysis(input.currentAnalysisId),
    intelligenceRepo.pathsForAnalysis(input.previousAnalysisId),
    intelligenceRepo.pathsForAnalysis(input.currentAnalysisId)
  ]);

  const diffInputs: DiffInputs = {
    monitorId: input.monitorId,
    previousAnalysisId: input.previousAnalysisId,
    currentAnalysisId: input.currentAnalysisId,
    previousJob,
    currentJob,
    previousScore,
    currentScore,
    previousSignals,
    currentSignals,
    previousPaths,
    currentPaths
  };
  const diff = buildExposureDiff(diffInputs);

  // Idempotent persist; a duplicate fan-out message reuses the existing row
  // and stops here (no duplicate events/notifications).
  const { created } = await diffRepo.insert({
    monitorId: input.monitorId,
    previousAnalysisId: input.previousAnalysisId,
    currentAnalysisId: input.currentAnalysisId,
    diff: diff as unknown as Record<string, unknown>
  });
  if (!created) {
    ctx.logger.debug("diff already processed", { monitorId: input.monitorId, currentAnalysisId: input.currentAnalysisId });
    return;
  }

  const rulesRow = await rulesRepo.getForMonitor(input.monitorId);
  const rules = rulesRow
    ? {
        id: String(rulesRow.id),
        monitorId: String(rulesRow.monitor_id),
        minimumSeverity: rulesRow.minimum_severity as never,
        minimumConfidence: Number(rulesRow.minimum_confidence),
        overallScoreDeltaThreshold: rulesRow.overall_score_delta_threshold,
        notifyNewEntity: rulesRow.notify_new_entity,
        notifyNewAttackPath: rulesRow.notify_new_attack_path,
        notifyBehaviorChange: rulesRow.notify_behavior_change,
        notifyDataQualityDegraded: rulesRow.notify_data_quality_degraded,
        cooldownHours: rulesRow.cooldown_hours,
        createdAt: rulesRow.created_at,
        updatedAt: rulesRow.updated_at
      }
    : null;
  if (!rules) {
    ctx.logger.warn("monitor has no alert rules, skipping", { monitorId: input.monitorId });
    return;
  }

  // Evaluate threats (pure) then apply rules with cooldown context.
  const candidates = evaluateThreats(diff, input.walletAddress);
  const cooldownSince = new Date(Date.now() - rules.cooldownHours * 3600_000).toISOString();
  const recentSameFingerprint = candidates.length > 0
    ? await eventRepo.recentForMonitor(input.monitorId, candidates[0]!.fingerprint, cooldownSince)
    : null;
  // Last event of the same fingerprint regardless of window (hysteresis).
  const lastEvent = candidates.length > 0
    ? await eventRepo.recentForMonitor(input.monitorId, candidates[0]!.fingerprint, "1970-01-01T00:00:00Z")
    : null;
  const lastEventDelta = lastEvent
    ? { fingerprint: lastEvent.fingerprint, delta: Number(lastEvent.occurrence_count) > 1 ? 999 : 0 }
    : null;
  const decisions = applyRules(candidates, rules, {
    recentSameFingerprint: recentSameFingerprint
      ? { fingerprint: recentSameFingerprint.fingerprint, delta: Number(recentSameFingerprint.occurrence_count) > 1 ? 999 : 0 }
      : null,
    lastEventDelta
  });

  for (const decision of decisions) {
    const event = decision.event;
    const persisted = await eventRepo.upsertByFingerprint({
      monitorId: input.monitorId,
      userId: input.monitorUserId,
      walletId: await walletIdFor(sql, input.monitorId, input.monitorUserId),
      diffId: (await diffRepo.listForMonitor(input.monitorId, 1))[0]?.id ?? null,
      eventType: event.eventType,
      severity: event.severity,
      confidence: event.confidence,
      subject: event.subject,
      fingerprint: event.fingerprint,
      title: event.title,
      summary: event.summary,
      explanation: event.explanation,
      evidence: event.evidence
    });

    if (decision.action !== "NOTIFY") continue;

    // One notification per channel, keyed by (fingerprint|channel): retries
    // can never duplicate (D4-F §52).
    const baseKey = createHash("sha256").update(`${event.fingerprint}|`).digest("hex");
    const inApp = await notificationRepo.insert({
      userId: input.monitorUserId,
      monitorId: input.monitorId,
      eventId: persisted.id,
      channel: "IN_APP",
      type: event.eventType,
      title: event.title,
      body: event.summary,
      severity: event.severity,
      idempotencyKey: `${baseKey}IN_APP`,
      status: "SENT"
    });
    if (inApp) {
      ctx.logger.info("in-app notification created", { notificationId: inApp.id, monitorId: input.monitorId });
    }

    if (config.ENABLE_EMAIL_NOTIFICATIONS && input.emailProvider.isConfigured()) {
      const email = await notificationRepo.insert({
        userId: input.monitorUserId,
        monitorId: input.monitorId,
        eventId: persisted.id,
        channel: "EMAIL",
        type: event.eventType,
        title: event.title,
        body: event.summary,
        severity: event.severity,
        idempotencyKey: `${baseKey}EMAIL`
      });
      if (email) {
        await ctx.queues.monitoring.add(
          "notify-deliver",
          { kind: "deliver", notificationId: email.id },
          { jobId: `notif-deliver-${email.id}`, attempts: 3, backoff: { type: "exponential", delay: 5000 } }
        );
      }
    }
  }

  // Bookkeeping + opportunistic event expiry (D4-H §68).
  await monitorRepo.touchCheck(input.monitorId, input.currentAnalysisId);
  await eventRepo.expireOld(new Date(Date.now() - config.MONITOR_EVENT_EXPIRY_DAYS * 86_400_000).toISOString()).catch(() => {});
}

async function walletIdFor(sql: ProcessorContext["sql"], monitorId: string, userId: string): Promise<string> {
  const [row] = await sql<Array<{ wallet_id: string }>>`
    select wallet_id::text from privacy_monitors where id = ${monitorId} and user_id = ${userId} limit 1
  `;
  if (!row) throw new Error("monitor not found for event persistence");
  return row.wallet_id;
}

/** Notification delivery worker handler, see D4-F §53-§54. */
export async function deliverNotification(ctx: ProcessorContext, notificationId: string): Promise<void> {
  const { sql, config, logger: baseLogger } = ctx;
  const logger = baseLogger.child({ notificationId });
  const notificationRepo = createNotificationRepo(sql);
  const emailProvider = createEmailProvider(config, logger);

  const notification = await notificationRepo.getById(notificationId);
  if (!notification) {
    logger.warn("notification not found");
    return;
  }
  if (notification.status !== "PENDING") {
    logger.debug("notification not pending, skipping delivery", { status: notification.status });
    return;
  }
  if (!config.ENABLE_EMAIL_NOTIFICATIONS) {
    await notificationRepo.markSuppressed(notificationId, "email notifications disabled");
    return;
  }

  try {
    await emailProvider.send({
      to: notification.user_id,
      subject: `${notification.title} — AEGIX`,
      body: notification.body
    });
    const delivered = await notificationRepo.markDelivered(notificationId);
    logger.info("notification delivered", { delivered });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // D5-J §50: permanent failures (invalid recipient, auth rejected) never
    // retry; transient failures retry with backoff. The PENDING status guard
    // keeps retries idempotent (no duplicate sends, D5-J §51).
    const permanent = err instanceof PermanentEmailError;
    if (permanent || Number(notification.attempt_count) >= config.MONITOR_CHECK_RETRY_LIMIT - 1) {
      await notificationRepo.markFailed(notificationId, permanent ? `permanent: ${message}` : `retry exhausted: ${message}`);
      logger.error("notification permanently failed", { notificationId, error: message.slice(0, 200) });
      return;
    }
    await notificationRepo.markFailed(notificationId, message);
    throw err; // BullMQ retries with backoff; the status guard prevents duplicates.
  }
}

export type { AegixQueues, AegixLogger };
