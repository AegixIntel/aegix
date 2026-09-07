import type { AppConfig } from "@aegix/config";

export const WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;

export function workerHeartbeatKey(config: AppConfig): string {
  return `${config.QUEUE_PREFIX}:worker:heartbeat`;
}

export function isFreshHeartbeat(value: string | null, now = Date.now()): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp <= now && now - timestamp <= WORKER_HEARTBEAT_MAX_AGE_MS;
}
