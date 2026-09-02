/**
 * Consumer-side webhook verification helper (D6-I4), see docs/webhooks.md.
 *
 * AEGIX signs every delivery with HMAC-SHA256 over
 * `timestamp + "." + rawBody`. Consumers must verify with the EXACT raw
 * request body bytes — never JSON.parse → JSON.stringify, because
 * serialization differences invalidate the signature.
 *
 * This helper is the canonical consumer implementation of the protocol
 * (signing lives in webhook-crypto.ts; this file only verifies).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Headers AEGIX sets on every delivery (same names as the delivery side). */
export const CONSUMER_WEBHOOK_HEADERS = {
  id: "aegix-webhook-id",
  eventId: "aegix-event-id",
  timestamp: "aegix-timestamp",
  signature: "aegix-signature"
} as const;

export type WebhookVerificationResult =
  | { valid: true }
  | { valid: false; reason: "MISSING_SIGNATURE" | "MISSING_TIMESTAMP" | "MALFORMED_TIMESTAMP" | "MALFORMED_SIGNATURE" | "TOO_OLD" | "TOO_FAR_IN_FUTURE" | "SIGNATURE_MISMATCH" };

export interface VerifyWebhookSignatureInput {
  /** The EXACT raw request body bytes as received (string form). */
  rawBody: string;
  /** Value of the aegix-signature header (hex HMAC-SHA256). */
  signature: string | null | undefined;
  /** Value of the aegix-timestamp header (Unix seconds). */
  timestamp: string | null | undefined;
  /** The webhook signing secret (from the AEGIX dashboard, shown once). */
  secret: string;
  /** Allowed clock skew in seconds (default 300 = 5 minutes). */
  toleranceSeconds?: number;
  /** Injectable clock for tests (Unix seconds). */
  nowSeconds?: number;
}

function hexToBuffer(hex: string): Buffer | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function parseTimestamp(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Constant-time verification of an AEGIX webhook signature, including
 * timestamp freshness. Returns a structured result — never throws for
 * invalid input.
 *
 *   const result = verifyWebhookRequest({
 *     rawBody,            // exact request body text
 *     signature: req.headers["aegix-signature"],
 *     timestamp:  req.headers["aegix-timestamp"],
 *     secret,
 *     toleranceSeconds: 300
 *   });
 *   if (!result.valid) { /* reject: too old / tampered / replay *\/ }
 */
export function verifyWebhookRequest(input: VerifyWebhookSignatureInput): WebhookVerificationResult {
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!input.signature) return { valid: false, reason: "MISSING_SIGNATURE" };
  if (!input.timestamp) return { valid: false, reason: "MISSING_TIMESTAMP" };

  const ts = parseTimestamp(input.timestamp);
  if (ts === null) return { valid: false, reason: "MALFORMED_TIMESTAMP" };

  const expected = createHmac("sha256", input.secret).update(`${input.timestamp}.${input.rawBody}`, "utf8").digest("hex");
  const provided = hexToBuffer(input.signature);
  const expectedBuf = hexToBuffer(expected);
  if (!provided || !expectedBuf) return { valid: false, reason: "MALFORMED_SIGNATURE" };
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    return { valid: false, reason: "SIGNATURE_MISMATCH" };
  }

  // Freshness AFTER signature validity: only a holder of the secret can
  // learn whether a replay window is accepted.
  if (now - ts > tolerance) return { valid: false, reason: "TOO_OLD" };
  if (ts - now > tolerance) return { valid: false, reason: "TOO_FAR_IN_FUTURE" };
  return { valid: true };
}
