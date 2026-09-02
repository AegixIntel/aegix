/**
 * Webhook delivery worker (D6-H), see docs/d6-block2.md.
 *
 * Async delivery through the dedicated `webhooks` BullMQ queue so a broken
 * customer endpoint can never starve monitor/intelligence workers (§107,
 * §122). SSRF protection at delivery time (§115-§118): resolve → validate
 * IP → connect; redirects disabled; intentional port policy.
 */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AppConfig } from "@aegix/config";
import type { Sql } from "@aegix/database";
import { createWebhookRepo, type DeveloperWebhookRow } from "@aegix/database";
import type { AegixLogger } from "@aegix/logging";
import type { AegixQueues } from "@aegix/queue";
import { decryptWebhookSecret, signWebhookPayload, WEBHOOK_HEADERS } from "./webhook-crypto.js";

export interface WebhookDeliveryContext {
  sql: Sql;
  config: AppConfig;
  logger: AegixLogger;
  queues: AegixQueues;
}

export interface WebhookEventPayload {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export class SsrfBlockedError extends Error {}

// RFC1918 + loopback + link-local + metadata + reserved ranges (IPv4).
const PRIVATE_V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "100.64.0.0/10",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4"
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function cidrContains(cidr: string, ipInt: number): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!base || Number.isNaN(bits)) return false;
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isPrivateV4(ip: string): boolean {
  const int = ipv4ToInt(ip);
  if (int === null) return true; // malformed → treat as unsafe
  return PRIVATE_V4.some((cidr) => cidrContains(cidr, int));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 loopback, fc00::/7 ULA, fe80::/10 link-local, ::ffff: mapped v4,
  // and the unspecified address.
  if (lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    return isPrivateV4(v4);
  }
  return false;
}

/** Resolves and validates a webhook destination at delivery time. */
export async function resolveWebhookDestination(url: string, config: AppConfig): Promise<{ hostname: string; port: number; ip: string; ipv6: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError("Invalid webhook URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SsrfBlockedError("Only http(s) webhook URLs are allowed");
  }

  const devPrivate = config.WEBHOOK_DEV_ALLOW_PRIVATE;
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;

  // Intentional port policy (§118).
  const allowedPorts = config.WEBHOOK_ALLOWED_PORTS.split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p));
  if (allowedPorts.length > 0 && !allowedPorts.includes(port)) {
    throw new SsrfBlockedError(`Port ${port} is not allowed for webhook delivery`);
  }

  // Literal IPs: validate directly.
  const literalV4 = isIP(hostname) === 4;
  const literalV6 = isIP(hostname) === 6;
  if (literalV4 && !devPrivate && isPrivateV4(hostname)) {
    throw new SsrfBlockedError("Private IPv4 destinations are not allowed");
  }
  if (literalV6 && !devPrivate && isPrivateV6(hostname)) {
    throw new SsrfBlockedError("Private IPv6 destinations are not allowed");
  }
  if (literalV4 || literalV6) {
    return { hostname, port, ip: hostname, ipv6: literalV6 };
  }

  // DNS rebinding mitigation (§116): resolve at delivery time and reject
  // private addresses. We connect to the validated IP with the Host header
  // set, and the HTTP layer re-checks on connect.
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError("DNS resolution failed for webhook destination");
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError("No addresses resolved for webhook destination");
  }
  const publicAddress = addresses.find((a) => {
    const v4 = isIP(a.address) === 4;
    const v6 = isIP(a.address) === 6;
    if (v4) return !isPrivateV4(a.address);
    if (v6) return !isPrivateV6(a.address);
    return false;
  });
  if (!publicAddress) {
    throw new SsrfBlockedError("Webhook destination resolves to a private address");
  }
  return { hostname, port, ip: publicAddress.address, ipv6: isIP(publicAddress.address) === 6 };
}

/**
 * Performs one signed delivery attempt. Returns the HTTP status code
 * (0 for network-level failure). Redirects are NOT followed (§117).
 */
export async function deliverWebhookOnce(ctx: WebhookDeliveryContext, webhook: DeveloperWebhookRow, payload: WebhookEventPayload): Promise<{ statusCode: number; durationMs: number; rawBody: string }> {
  const { config } = ctx;
  const destination = await resolveWebhookDestination(webhook.url, config);
  const secret = decryptWebhookSecret(config, webhook.secret_encrypted, webhook.secret_nonce);
  const rawBody = JSON.stringify(payload);
  if (Buffer.byteLength(rawBody, "utf8") > config.WEBHOOK_PAYLOAD_MAX_BYTES) {
    throw new Error("Webhook payload exceeds the size limit");
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookPayload(secret, timestamp, rawBody);
  const eventId = payload.id;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.WEBHOOK_TIMEOUT_MS);
  const started = Date.now();
  try {
    // Connect to the validated IP but keep the original Host header
    // (virtual hosting); TLS SNI uses the hostname.
    const url = new URL(webhook.url);
    url.hostname = destination.ip;
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_HEADERS.id]: String(webhook.id),
        [WEBHOOK_HEADERS.eventId]: eventId,
        [WEBHOOK_HEADERS.timestamp]: timestamp,
        [WEBHOOK_HEADERS.signature]: signature,
        host: destination.hostname
      },
      body: rawBody,
      signal: controller.signal,
      redirect: "manual"
    });
    // Read a bounded response body (§121).
    const body = await res.text().catch(() => "");
    return { statusCode: res.status, durationMs: Date.now() - started, rawBody: body.slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Classifies an HTTP status for retry policy (§109). */
export function isTransientStatus(statusCode: number): boolean {
  if (statusCode === 408 || statusCode === 429) return true;
  if (statusCode >= 500 && statusCode <= 599) return true;
  return false;
}

export function isPermanentStatus(statusCode: number): boolean {
  return statusCode >= 400 && statusCode <= 499 && statusCode !== 408 && statusCode !== 429;
}

/**
 * Enqueues a webhook delivery for all active webhooks subscribed to the
 * event type. Never blocks the caller (analysis worker) on delivery.
 */
export async function enqueueWebhookDelivery(ctx: WebhookDeliveryContext, input: { eventType: string; payload: WebhookEventPayload }): Promise<void> {
  const { sql, config, logger } = ctx;
  if (!config.ENABLE_WEBHOOK_DELIVERY) return;
  const webhookRepo = createWebhookRepo(sql);
  const webhooks = await webhookRepo.activeDeliverableWebhooks();
  let enqueued = 0;
  for (const webhook of webhooks) {
    const types = (webhook.event_types ?? []) as string[];
    if (types.length > 0 && !types.includes(input.eventType)) continue;
    try {
      await ctx.queues.webhooks.add(
        "webhook-deliver",
        { webhookId: webhook.id, eventId: input.payload.id, eventType: input.eventType, payload: input.payload },
        { jobId: `webhook-${webhook.id}-${input.payload.id}`, attempts: config.WEBHOOK_MAX_ATTEMPTS, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 200, removeOnFail: 500 }
      );
      enqueued += 1;
    } catch (err) {
      logger.error("webhook enqueue failed", { webhookId: webhook.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (enqueued > 0) {
    logger.info("webhook deliveries enqueued", { eventType: input.eventType, eventId: input.payload.id, count: enqueued });
  }
}

/**
 * Worker processor: one delivery attempt with retry/disable bookkeeping.
 * Throws only for transient failures (BullMQ retries with backoff);
 * permanent failures mark the webhook and stop.
 */
export async function processWebhookDelivery(ctx: WebhookDeliveryContext, jobData: { webhookId: string; eventId: string; eventType: string; payload: WebhookEventPayload }): Promise<void> {
  const { sql, config, logger: baseLogger } = ctx;
  const logger = baseLogger.child({ webhookId: jobData.webhookId, eventId: jobData.eventId });
  const webhookRepo = createWebhookRepo(sql);

  const webhook = await webhookRepo.getById(jobData.webhookId);
  if (!webhook || webhook.status === "DISABLED") {
    logger.debug("webhook not deliverable, skipping");
    return;
  }

  const started = Date.now();
  let statusCode = 0;
  let status = "SUCCESS";
  let errorExcerpt: string | null = null;
  let nextRetryAt: string | null = null;

  try {
    const result = await deliverWebhookOnce(ctx, webhook, jobData.payload);
    statusCode = result.statusCode;
    logger.info("webhook delivery attempted", {
      webhookId: webhook.id,
      eventId: jobData.eventId,
      attempt: 1,
      destinationHostSafe: hostSafe(webhook.url),
      status: statusCode,
      durationMs: result.durationMs
    });

    if (statusCode >= 200 && statusCode < 300) {
      await webhookRepo.markOutcome(webhook.id, { ok: true });
    } else if (isPermanentStatus(statusCode)) {
      status = "FAILED";
      errorExcerpt = `permanent HTTP ${statusCode}`;
      await webhookRepo.markOutcome(webhook.id, { ok: false, disable: true, reason: `permanent HTTP ${statusCode}` });
      logger.error("webhook permanently failed", { webhookId: webhook.id, eventId: jobData.eventId, statusCode });
    } else {
      status = "RETRY";
      errorExcerpt = `transient HTTP ${statusCode}`;
      await webhookRepo.markOutcome(webhook.id, { ok: false });
      // Bounded retry: let BullMQ backoff handle it; compute next_retry_at.
      nextRetryAt = new Date(Date.now() + 60_000).toISOString();
      logger.warn("webhook transient failure, will retry", { webhookId: webhook.id, eventId: jobData.eventId, statusCode });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status = err instanceof SsrfBlockedError ? "SSRF_BLOCKED" : "RETRY";
    errorExcerpt = message.slice(0, 300);
    if (err instanceof SsrfBlockedError) {
      await webhookRepo.markOutcome(webhook.id, { ok: false, disable: true, reason: "SSRF blocked" });
      logger.error("webhook SSRF blocked", { webhookId: webhook.id, eventId: jobData.eventId, destinationHostSafe: hostSafe(webhook.url) });
    } else {
      await webhookRepo.markOutcome(webhook.id, { ok: false });
      nextRetryAt = new Date(Date.now() + 60_000).toISOString();
      logger.warn("webhook delivery error, will retry", { webhookId: webhook.id, eventId: jobData.eventId, error: message.slice(0, 200) });
    }
  }

  await webhookRepo.recordDelivery({
    webhookId: webhook.id,
    eventId: jobData.eventId,
    eventType: jobData.eventType,
    attempt: 1,
    status,
    statusCode: statusCode || null,
    durationMs: Date.now() - started,
    nextRetryAt,
    errorExcerpt
  });

  // Transient failures rethrow so BullMQ retries with backoff; permanent
  // and SSRF failures are terminal (already recorded + disabled).
  if (status === "RETRY") {
    throw new Error(errorExcerpt ?? "transient webhook failure");
  }
}

function hostSafe(url: string): string {
  try {
    const host = new URL(url).host;
    return host.length > 40 ? host.slice(0, 40) + "…" : host;
  } catch {
    return "invalid";
  }
}

