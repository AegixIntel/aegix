import { createHash } from "node:crypto";
import type { AppConfig } from "@aegix/config";
import {
  createAnalysisJobRepo,
  createCorrelationRepo,
  createExposureDiffRepo,
  createIntelligenceRepo,
  createMonitorAlertRulesRepo,
  createMonitorCorrelationRepo,
  createMonitorRepo,
  createNotificationRepo,
  createProfileRepo,
  createThreatEventRepo,
  createWalletRepo
} from "@aegix/database";
import type { AegixQueues } from "@aegix/queue";
import type { AegixLogger } from "@aegix/logging";
import type { ProcessorContext } from "./types.js";
import { buildExposureDiff, type DiffInputs } from "@aegix/diff";
import { applyRules, evaluateThreats } from "./threat.js";
import { applyCorrelationRules, evaluateCorrelationChanges, CORRELATION_MONITOR_ENGINE_VERSION, type CorrelationSnapshot } from "./correlation.js";
import { createEmailProvider, PermanentEmailError, type EmailProvider } from "./email.js";
import { buildCorrelationEmail, correlationEmailEligibility } from "./notification-email.js";

/** A notification-channel fan-out reason string (§7: email-unconfigured is a
 *  valid product state, never a failure). */
export const EMAIL_SKIP_REASON = "EMAIL_NOT_CONFIGURED";

/** D6-H §106: maps internal event types to the webhook event vocabulary. */
const WEBHOOK_EVENT_MAP: Record<string, string> = {
  PRIVACY_EXPOSURE_INCREASED: "monitor.threat.created",
  IDENTITY_LINKABILITY_INCREASED: "monitor.threat.created",
  NEW_ENTITY_EXPOSURE: "monitor.threat.created",
  NEW_REPEATED_FUNDER: "monitor.threat.created",
  NEW_STRONG_COUNTERPARTY_LINK: "monitor.threat.created",
  NEW_ATTACK_PATH: "monitor.threat.created",
  ATTACK_PATH_STRENGTHENED: "monitor.threat.created",
  DATA_QUALITY_DEGRADED: "monitor.threat.created",
  CORRELATION_APPEARED: "correlation.appeared",
  CORRELATION_INCREASED: "correlation.increased",
  CORRELATION_DECREASED: "correlation.decreased",
  CORRELATION_DISAPPEARED: "correlation.disappeared"
};

/** Best-effort webhook fan-out for a monitor event (§107: async, never
 *  blocks the pipeline; a queue failure is logged, not thrown). */
export async function fanOutWebhook(ctx: ProcessorContext, eventType: string, data: Record<string, unknown>): Promise<void> {
  const { config, logger } = ctx;
  if (!config.ENABLE_WEBHOOK_DELIVERY) return;
  const webhookType = WEBHOOK_EVENT_MAP[eventType];
  if (!webhookType) return;
  try {
    const { enqueueWebhookDelivery } = await import("@aegix/webhook-delivery");
    await enqueueWebhookDelivery(ctx, {
      eventType: webhookType,
      payload: {
        id: crypto.randomUUID(),
        type: webhookType,
        createdAt: new Date().toISOString(),
        data
      }
    });
  } catch (err) {
    logger.error("webhook fan-out failed", { eventType, error: err instanceof Error ? err.message : String(err) });
  }
}

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
  const profileRepo = createProfileRepo(sql);
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

    // D6-H §105-§107: fan out to subscribed webhooks (async, best-effort).
    await fanOutWebhook(ctx, event.eventType, {
      monitorId: input.monitorId,
      eventId: persisted.id,
      eventType: event.eventType,
      severity: event.severity,
      confidence: event.confidence,
      subject: event.subject,
      summary: event.summary,
      evidence: event.evidence
    });

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

    // EMAIL is an optional channel (§6): only create a PENDING row + delivery
    // job when the global switches, the provider, AND a verified destination
    // all exist. A missing/disabled email is EMAIL_NOT_CONFIGURED — it is
    // never a pipeline failure and never produces useless PENDING rows (§13).
    const emailProfile = await profileRepo.getEmailForUser(input.monitorUserId);
    const emailEligibility = correlationEmailEligibility({
      config,
      providerConfigured: input.emailProvider.isConfigured(),
      recipient: emailProfile
        ? { email: emailProfile.notification_email, verifiedAt: emailProfile.notification_email_verified_at }
        : null
    });
    if (emailEligibility.eligible) {
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
    } else {
      // Email skipped because it is not configured for this user/event —
      // a valid product state, not an error, not a failure (§7, §28).
      if (config.EMAIL_ENABLED && config.ENABLE_EMAIL_NOTIFICATIONS) {
        ctx.logger.debug("email channel skipped", {
          monitorId: input.monitorId,
          eventType: event.eventType,
          reason: emailEligibility.reason ?? EMAIL_SKIP_REASON
        });
      }
    }
  }

  // Bookkeeping + opportunistic event expiry (D4-H §68).
  await monitorRepo.touchCheck(input.monitorId, input.currentAnalysisId);
  await eventRepo.expireOld(new Date(Date.now() - config.MONITOR_EVENT_EXPIRY_DAYS * 86_400_000).toISOString()).catch(() => {});

  // D6-F §64-§77: correlation change detection for this monitor (opt-in via
  // ENABLE_CORRELATION_MONITOR_ALERTS; per-monitor rules gate notifications).
  if (config.ENABLE_CORRELATION_MONITOR_ALERTS) {
    try {
      await processCorrelationChanges(ctx, {
        monitorId: input.monitorId,
        monitorUserId: input.monitorUserId,
        walletAddress: input.walletAddress,
        currentAnalysisId: input.currentAnalysisId
      });
    } catch (err) {
      // Correlation alerts are additive: a failure here must not break the
      // exposure pipeline outcome already persisted.
      ctx.logger.error("correlation alert stage failed", { monitorId: input.monitorId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * D6-F: compares the monitor's persisted correlation baselines against the
 * current persisted correlation results for the monitored wallet. Bounded
 * candidates (§69): only wallets already in correlation_results for the
 * monitored wallet (capped by MAX_MONITOR_CORRELATION_CANDIDATES).
 */
async function processCorrelationChanges(
  ctx: ProcessorContext,
  input: {
    monitorId: string;
    monitorUserId: string;
    walletAddress: string;
    currentAnalysisId: string;
  }
): Promise<void> {
  const { sql, config, logger: baseLogger } = ctx;
  const logger = baseLogger.child({ monitorId: input.monitorId });
  const correlationRepo = createCorrelationRepo(sql);
  const monitorCorrRepo = createMonitorCorrelationRepo(sql);
  const notificationRepo = createNotificationRepo(sql);
  const rulesRepo = createMonitorAlertRulesRepo(sql);
  const walletRepo = createWalletRepo(sql);
  const emailProvider = createEmailProvider(config, logger);
  const profileRepo = createProfileRepo(sql);

  const wallet = await walletRepo.findByAddress("solana", input.walletAddress);
  if (!wallet) return;

  // Current persisted correlations for the monitored wallet (bounded).
  const rows = await correlationRepo.listForWallet(input.walletAddress, config.MAX_MONITOR_CORRELATION_CANDIDATES);
  const current: CorrelationSnapshot[] = rows.map((r) => ({
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

  // Previous baselines.
  const baselines = await monitorCorrRepo.listBaselines(input.monitorId);
  const baselineByPair = new Map(baselines.map((b) => [b.wallet_a === input.walletAddress ? [input.walletAddress, b.wallet_b].sort().join("|") : [b.wallet_a, input.walletAddress].sort().join("|"), b]));
  const currentByPair = new Map(current.map((c) => [c.pairId, c]));

  const rulesRow = await rulesRepo.getForMonitor(input.monitorId);
  const alertConfig = {
    enterStrongScore: config.CORRELATION_ALERT_ENTER_STRONG,
    exitStrongScore: config.CORRELATION_ALERT_EXIT_STRONG,
    minDelta: config.CORRELATION_ALERT_MIN_DELTA,
    minScore: rulesRow ? Number(rulesRow.correlation_min_score) : 40,
    minConfidence: rulesRow ? Number(rulesRow.correlation_min_confidence) : 0.5,
    cooldownHours: rulesRow ? rulesRow.cooldown_hours : config.MONITOR_EVENT_COOLDOWN_HOURS,
    notifyCorrelationChange: rulesRow ? rulesRow.notify_correlation_change : true
  };

  const cooldownSince = new Date(Date.now() - alertConfig.cooldownHours * 3600_000).toISOString();

  for (const currentSnapshot of current) {
    const previousSnapshot = baselineByPair.get(currentSnapshot.pairId);
    const candidates = evaluateCorrelationChanges(
      input.monitorId,
      input.walletAddress,
      previousSnapshot
        ? {
            walletA: previousSnapshot.wallet_a,
            walletB: previousSnapshot.wallet_b,
            pairId: currentSnapshot.pairId,
            correlationScore: previousSnapshot.correlation_score,
            confidence: previousSnapshot.confidence,
            classification: previousSnapshot.classification,
            evidenceFamilies: ((previousSnapshot.evidence_families ?? []) as Array<{ family: string; strength: number }>).map((f) => ({ family: f.family, strength: Number(f.strength) })),
            engineVersion: previousSnapshot.engine_version,
            correlationResultId: previousSnapshot.correlation_result_id
          }
        : null,
      currentSnapshot,
      alertConfig
    );
    if (candidates.length === 0) continue;

    for (const candidate of candidates) {
      const recent = await monitorCorrRepo.recentEvent(input.monitorId, candidate.fingerprint, cooldownSince);
      const lastEvent = await monitorCorrRepo.recentEvent(input.monitorId, candidate.fingerprint, "1970-01-01T00:00:00Z");
      const decisions = applyCorrelationRules([candidate], alertConfig, {
        recentSameFingerprint: recent ? { fingerprint: recent.fingerprint, lastSeenAt: recent.last_seen_at, occurrenceCount: recent.occurrence_count } : null,
        lastScore: candidate.eventType === "CORRELATION_INCREASED" ? lastEvent?.new_score ?? previousSnapshot?.correlation_score ?? null : null
      });
      const decision = decisions[0];
      if (!decision) continue;

      const persisted = await monitorCorrRepo.upsertEvent({
        monitorId: input.monitorId,
        userId: input.monitorUserId,
        walletId: wallet.id,
        relatedWallet: candidate.relatedWallet,
        eventType: candidate.eventType,
        severity: candidate.severity,
        confidence: candidate.confidence,
        previousScore: candidate.previousScore,
        newScore: candidate.newScore,
        previousConfidence: candidate.previousConfidence,
        newConfidence: candidate.newConfidence,
        evidence: candidate.evidence as Record<string, unknown>,
        limitations: candidate.limitations,
        engineVersion: CORRELATION_MONITOR_ENGINE_VERSION,
        fingerprint: candidate.fingerprint
      });

      if (decision.action === "NOTIFY") {
        // D6-H §105-§107: fan out to subscribed webhooks (async, best-effort).
        await fanOutWebhook(ctx, candidate.eventType, {
          monitorId: input.monitorId,
          eventId: persisted.id,
          eventType: candidate.eventType,
          severity: candidate.severity,
          confidence: candidate.confidence,
          relatedWallet: candidate.relatedWallet,
          previousScore: candidate.previousScore,
          newScore: candidate.newScore,
          previousConfidence: candidate.previousConfidence,
          newConfidence: candidate.newConfidence,
          summary: candidate.summary,
          evidence: candidate.evidence
        });
        const baseKey = createHash("sha256").update(`${candidate.fingerprint}|`).digest("hex");
        const inApp = await notificationRepo.insert({
          userId: input.monitorUserId,
          monitorId: input.monitorId,
          eventId: persisted.id,
          channel: "IN_APP",
          type: candidate.eventType,
          title: candidate.title,
          body: candidate.summary,
          severity: candidate.severity,
          idempotencyKey: `${baseKey}IN_APP`,
          status: "SENT"
        });
        if (inApp) {
          logger.info("correlation in-app notification created", {
            monitorId: input.monitorId,
            notificationId: inApp.id,
            correlationEventId: persisted.id
          });
        }

        // D6-I1: EMAIL fan-out for correlation alerts. One logical event
        // yields at most one EMAIL notification (same fingerprint-derived
        // idempotency key as IN_APP). Email eligibility requires the global
        // email switches, a configured provider, and a VERIFIED notification
        // email destination (wallet-only auth: email ≠ identity, §7-§8).
        // The pipeline only persists + enqueues; the worker resolves the
        // current recipient at delivery time.
        const emailProfile = await profileRepo.getEmailForUser(input.monitorUserId);
        const eligibility = correlationEmailEligibility({
          config,
          providerConfigured: emailProvider.isConfigured(),
          recipient: emailProfile
            ? { email: emailProfile.notification_email, verifiedAt: emailProfile.notification_email_verified_at }
            : null
        });
        if (eligibility.eligible) {
          const content = buildCorrelationEmail({
            candidate,
            monitoredWallet: input.walletAddress,
            appUri: config.AUTH_APP_URI
          });
          const email = await notificationRepo.insert({
            userId: input.monitorUserId,
            monitorId: input.monitorId,
            eventId: persisted.id,
            channel: "EMAIL",
            type: candidate.eventType,
            title: content.subject,
            body: content.body,
            severity: candidate.severity,
            idempotencyKey: `${baseKey}EMAIL`
          });
          if (email) {
            await ctx.queues.monitoring.add(
              "notify-deliver",
              { kind: "deliver", notificationId: email.id },
              { jobId: `notif-deliver-${email.id}`, attempts: 3, backoff: { type: "exponential", delay: 5000 } }
            );
            logger.info("correlation email notification queued", {
              monitorId: input.monitorId,
              notificationId: email.id,
              correlationEventId: persisted.id,
              eventType: candidate.eventType
            });
          }
        } else if (config.EMAIL_ENABLED && config.ENABLE_EMAIL_NOTIFICATIONS) {
          // Email is enabled globally but this event cannot be emailed
          // (provider or verified recipient missing) — log once, never fake
          // a delivery.
          logger.debug("correlation email skipped", {
            monitorId: input.monitorId,
            reason: eligibility.reason ?? "unknown",
            eventType: candidate.eventType
          });
        }
        logger.info("correlation alert created", {
          monitorId: input.monitorId,
          correlationResultId: persisted.id,
          eventType: candidate.eventType,
          previousScore: candidate.previousScore,
          newScore: candidate.newScore,
          previousConfidence: candidate.previousConfidence,
          newConfidence: candidate.newConfidence,
          suppressed: false
        });
      } else {
        logger.info("correlation alert suppressed", {
          monitorId: input.monitorId,
          eventType: candidate.eventType,
          suppressionReason: decision.reasons.join("; ")
        });
      }
    }
  }

  // Update baselines to the current persisted set (snapshot semantics:
  // pairs no longer present are dropped; new pairs become baselines).
  const seen = new Set<string>();
  for (const currentSnapshot of current) {
    const existing = baselineByPair.get(currentSnapshot.pairId);
    await monitorCorrRepo.upsertBaseline({
      monitorId: input.monitorId,
      walletA: currentSnapshot.walletA,
      walletB: currentSnapshot.walletB,
      correlationScore: currentSnapshot.correlationScore,
      confidence: currentSnapshot.confidence,
      classification: currentSnapshot.classification,
      correlationResultId: currentSnapshot.correlationResultId,
      evidenceFamilies: currentSnapshot.evidenceFamilies,
      engineVersion: currentSnapshot.engineVersion
    });
    seen.add(currentSnapshot.pairId);
  }
  // Pairs no longer in the persisted set keep their baseline row (history);
  // the next cycle compares against it and produces DISAPPEARED only when
  // evidence is conclusive.
  void seen;
}

async function walletIdFor(sql: ProcessorContext["sql"], monitorId: string, userId: string): Promise<string> {
  const [row] = await sql<Array<{ wallet_id: string }>>`
    select wallet_id::text from privacy_monitors where id = ${monitorId} and user_id = ${userId} limit 1
  `;
  if (!row) throw new Error("monitor not found for event persistence");
  return row.wallet_id;
}

/** Notification delivery worker handler, see D4-F §53-§54 and D6-I1.
 *  The recipient is the profile's VERIFIED notification email, resolved at
 *  delivery time (never the user id, never an unverified address, D6-I1 §8).
 *  A stale/missing verified destination suppresses the delivery — email is
 *  never silently faked. */
export async function deliverNotification(ctx: ProcessorContext, notificationId: string): Promise<void> {
  const { sql, config, logger: baseLogger } = ctx;
  const logger = baseLogger.child({ notificationId });
  const notificationRepo = createNotificationRepo(sql);
  const profileRepo = createProfileRepo(sql);
  const emailProvider = createEmailProvider(config, logger);

  const notification = await notificationRepo.getById(notificationId);
  if (!notification) {
    logger.warn("notification not found");
    return;
  }
  if (notification.channel !== "EMAIL") {
    await notificationRepo.markSuppressed(notificationId, "not an email channel");
    return;
  }
  if (notification.status !== "PENDING") {
    logger.debug("notification not pending, skipping delivery", { status: notification.status });
    return;
  }
  if (!config.EMAIL_ENABLED || !config.ENABLE_EMAIL_NOTIFICATIONS) {
    await notificationRepo.markSuppressed(notificationId, "email notifications disabled");
    return;
  }
  if (!emailProvider.isConfigured()) {
    await notificationRepo.markSuppressed(notificationId, "email provider not configured");
    return;
  }

  // Verified destination only (§8): the profile email must exist AND be
  // verified at delivery time. If the user removed/unverified their email
  // after the notification was queued, suppress instead of sending.
  const profileEmail = await profileRepo.getEmailForUser(notification.user_id);
  const to = profileEmail?.notification_email && profileEmail.notification_email_verified_at ? profileEmail.notification_email : null;
  if (!to) {
    await notificationRepo.markSuppressed(notificationId, "no verified notification email destination");
    logger.debug("email notification suppressed: no verified destination", { notificationId });
    return;
  }

  try {
    await emailProvider.send({
      to,
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
    // Transient failure: record the attempt but keep status PENDING so the
    // BullMQ retry still passes the status guard and can actually resend
    // (D5-J §51). The previous markFailed flip to FAILED made retries no-ops.
    await notificationRepo.recordAttempt(notificationId, message);
    throw err; // BullMQ retries with backoff; the status guard prevents duplicates.
  }
}

export type { AegixQueues, AegixLogger };
