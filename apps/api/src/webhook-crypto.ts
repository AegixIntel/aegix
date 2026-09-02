/**
 * Webhook management + delivery (D6-H), see docs/d6-block2.md.
 *
 * - Secrets are AES-256-GCM encrypted at rest (WEBHOOK_ENCRYPTION_KEY);
 *   the plaintext is shown exactly once at creation and on rotation.
 * - Delivery is async (dedicated queue), signed with HMAC-SHA256 over
 *   `timestamp + "." + rawBody`; headers carry webhook/event/timestamp/
 *   signature ids for consumer verification and replay protection.
 * - SSRF protection is a release blocker: at delivery time the hostname is
 *   resolved and validated (private/loopback/link-local/metadata/reserved
 *   ranges rejected), only http(s) schemes and an intentional port policy
 *   are allowed, and redirects are disabled.
 */

import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "@aegix/config";

/** Key id prefix so future rotation keeps old payloads verifiable. */
export const WEBHOOK_SECRET_KEY_VERSION = "v1";

export interface WebhookSecretMaterial {
  secret: string;
  encrypted: string;
  nonce: string;
  keyVersion: string;
}

export class WebhookSecretError extends Error {}

function encryptionKey(config: AppConfig): Buffer {
  const key = config.WEBHOOK_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new WebhookSecretError("WEBHOOK_ENCRYPTION_KEY must be set (32+ chars) when webhooks are enabled");
  }
  // Derive a 32-byte key from the configured secret (SHA-256).
  return createHash("sha256").update(key, "utf8").digest();
}

/** Generates a high-entropy signing secret, encrypted at rest. */
export function createWebhookSecret(config: AppConfig): WebhookSecretMaterial {
  const secret = randomBytes(32).toString("base64url");
  const nonce = randomBytes(12);
  const key = encryptionKey(config);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]).toString("base64");
  const tag = cipher.getAuthTag().toString("base64");
  return { secret, encrypted: `${encrypted}.${tag}`, nonce: nonce.toString("base64"), keyVersion: WEBHOOK_SECRET_KEY_VERSION };
}

/** Decrypts a stored secret for signing. */
export function decryptWebhookSecret(config: AppConfig, encrypted: string, nonceB64: string): string {
  const key = encryptionKey(config);
  const [ctB64, tagB64] = encrypted.split(".");
  if (!ctB64 || !tagB64) throw new WebhookSecretError("Malformed stored webhook secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** HMAC-SHA256 signature over `timestamp + "." + rawBody` (§102). */
export function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** Constant-time verification of a signature (§102). */
export function verifyWebhookSignature(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = signWebhookPayload(secret, timestamp, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export const WEBHOOK_HEADERS = {
  id: "aegix-webhook-id",
  eventId: "aegix-event-id",
  timestamp: "aegix-timestamp",
  signature: "aegix-signature"
} as const;

export { encryptionKey as webhookEncryptionKey };
