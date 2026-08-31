import type { AppConfig } from "@aegix/config";
import type { AegixQueues } from "@aegix/queue";
import type { AegixLogger } from "@aegix/logging";

/**
 * Registers the monitor scheduler, see docs/milestone-d4.md (D4-B §11-§13).
 *
 * Uses BullMQ's upsertJobScheduler (repeatable job): idempotent by design —
 * re-registering on worker restart replaces the definition instead of adding
 * a second scheduler. The tick job is cheap (a DB sweep of due monitors);
 * the expensive per-monitor work is enqueued with deterministic jobIds so a
 * re-run in the same schedule window is a no-op (no duplicate analysis jobs).
 */
export async function registerMonitorScheduler(queues: AegixQueues, config: AppConfig, logger: AegixLogger): Promise<void> {
  if (!config.ENABLE_MONITOR_SCHEDULER || !config.ENABLE_MONITORING) {
    logger.info("monitor scheduler disabled", {
      ENABLE_MONITOR_SCHEDULER: config.ENABLE_MONITOR_SCHEDULER,
      ENABLE_MONITORING: config.ENABLE_MONITORING
    });
    return;
  }
  try {
    await queues.monitoring.upsertJobScheduler(
      "monitor-check",
      { pattern: config.MONITOR_SCHEDULER_CRON },
      {
        name: "monitor-check",
        data: { kind: "check" } as const,
        opts: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 500
        }
      }
    );
    logger.info("monitor scheduler registered", { cron: config.MONITOR_SCHEDULER_CRON });
  } catch (err) {
    // A failed scheduler registration must not kill the worker; the queue
    // simply won't tick. The error is logged and retried on next boot.
    logger.error("monitor scheduler registration failed", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
