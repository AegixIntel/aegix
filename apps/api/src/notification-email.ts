/**
 * Notification-email destination management (D6-I1 §7-§8).
 *
 * Wallet-only authentication is canonical: the notification email is NOT an
 * identity. It is an optional destination, and it only becomes usable after
 * code verification. The verification code is delivered through the same
 * transactional email pipeline (console provider in dev prints it; SMTP
 * sends it) and only its SHA-256 digest is stored (same pattern as wallet
 * auth nonces). Unverified destinations are never emailed.
 */

import { createHash, randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { Sql } from "@aegix/database";
import { createProfileRepo } from "@aegix/database";
import type { AegixLogger } from "@aegix/logging";
import { createEmailProvider } from "@aegix/monitor";

export const EMAIL_VERIFICATION_CODE_TTL_MINUTES = 15;
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
/** Plain email shape check only; delivery/verification is the actual gate. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidNotificationEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

export function hashEmailCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export interface NotificationEmailRoutesDeps {
  app: FastifyInstance;
  sql: Sql;
  config: AppConfig;
  logger: AegixLogger;
  requireUser: NotificationEmailRequireUser;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The notification-email routes require an authenticated product user. */
type NotificationEmailAuthUser = { id: string };

export type NotificationEmailRequireUser = (req: FastifyRequest, reply: FastifyReply) => Promise<NotificationEmailAuthUser | null>;

function requestIdOf(reply: FastifyReply): string {
  return (reply.request?.headers["x-request-id"] as string | undefined) ?? "unknown";
}

/**
 * Registers:
 *   GET  /v1/me/email            → current destination state (never the code)
 *   PUT  /v1/me/email            → set destination, issue + send verification
 *                                   code (email NOT verified yet)
 *   POST /v1/me/email/verify     → verify with the delivered code
 *   DELETE /v1/me/email          → remove the destination
 */
export function registerNotificationEmailRoutes(deps: NotificationEmailRoutesDeps): void {
  const { app, sql, config, logger, requireUser } = deps;
  const profileRepo = createProfileRepo(sql);
  const emailProvider = createEmailProvider(config, logger);

  const gate = (reply: FastifyReply): boolean => {
    if (!config.ENABLE_EMAIL_NOTIFICATIONS || !config.EMAIL_ENABLED) {
      reply.code(403).send({ error: { code: "FEATURE_DISABLED", message: "Email notifications are disabled" }, meta: { requestId: requestIdOf(reply) } });
      return true;
    }
    return false;
  };

  app.get("/v1/me/email", async (req, reply) => {
    if (gate(reply)) return;
    const user = await requireUser(req, reply);
    if (!user) return;
    const row = await profileRepo.getEmailForUser(user.id);
    const email = row?.notification_email ?? null;
    const verified = Boolean(email && row?.notification_email_verified_at);
    return reply.send({
      data: { email, verified, verificationPending: Boolean(email && !verified && row?.email_verification_code_hash) },
      meta: { requestId: requestIdOf(reply) }
    });
  });

  app.put<{ Body: { email: string } }>(
    "/v1/me/email",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", minLength: 3, maxLength: 254 } }
        }
      }
    },
    async (req, reply) => {
      if (gate(reply)) return;
      const user = await requireUser(req, reply);
      if (!user) return;
      const email = req.body.email.trim().toLowerCase();
      if (!isValidNotificationEmail(email)) {
        return reply.code(400).send({ error: { code: "INVALID_EMAIL", message: "Invalid email address" }, meta: { requestId: requestIdOf(reply) } });
      }
      if (!emailProvider.isConfigured()) {
        return reply.code(503).send({ error: { code: "EMAIL_UNAVAILABLE", message: "Email delivery is not configured on the server" }, meta: { requestId: requestIdOf(reply) } });
      }

      // Store unverified + issue code (digest only at rest).
      await profileRepo.setNotificationEmail(user.id, email);
      const code = generateEmailCode();
      const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_CODE_TTL_MINUTES * 60_000).toISOString();
      await profileRepo.storeEmailVerificationCode(user.id, hashEmailCode(code), expiresAt);

      // Deliver the code through the standard email pipeline (never logged
      // in plaintext; console provider prints for local development).
      try {
        await emailProvider.send({
          to: email,
          subject: "Verify your AEGIX notification email",
          body: `Your AEGIX notification-email verification code is:\n\n${code}\n\nThe code expires in ${EMAIL_VERIFICATION_CODE_TTL_MINUTES} minutes. AEGIX uses this address only for privacy alerts you opt into — it is never a login credential.`
        });
      } catch {
        // The code is stored; a failed send simply means the user can
        // request a new code (idempotent PUT).
        logger.warn("notification email verification code send failed", { requestId: requestIdOf(reply) });
      }

      logger.info("notification email set, verification pending", { requestId: requestIdOf(reply) });
      return reply.send({ data: { email, verified: false }, meta: { requestId: requestIdOf(reply) } });
    }
  );

  app.post<{ Body: { code: string } }>(
    "/v1/me/email/verify",
    {
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string", minLength: 6, maxLength: 6 } }
        }
      }
    },
    async (req, reply) => {
      if (gate(reply)) return;
      const user = await requireUser(req, reply);
      if (!user) return;
      const row = await profileRepo.getEmailForUser(user.id);
      const codeHash = row?.email_verification_code_hash;
      const expiresAt = row?.email_verification_code_expires_at;
      const attempts = row?.email_verification_attempts ?? 0;
      if (!row?.notification_email || !codeHash || !expiresAt) {
        return reply.code(400).send({ error: { code: "NO_PENDING_VERIFICATION", message: "Set an email first" }, meta: { requestId: requestIdOf(reply) } });
      }
      if (attempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
        return reply.code(429).send({ error: { code: "VERIFICATION_LIMIT_REACHED", message: "Too many attempts — set the email again for a new code" }, meta: { requestId: requestIdOf(reply) } });
      }
      if (new Date(expiresAt) < new Date()) {
        return reply.code(400).send({ error: { code: "CODE_EXPIRED", message: "Verification code expired — set the email again" }, meta: { requestId: requestIdOf(reply) } });
      }

      const consumed = await profileRepo.consumeEmailVerificationAttempt(user.id);
      if (!consumed || !safeEqual(hashEmailCode(req.body.code), codeHash)) {
        return reply.code(400).send({ error: { code: "INVALID_CODE", message: "Invalid verification code" }, meta: { requestId: requestIdOf(reply) } });
      }
      await profileRepo.markEmailVerified(user.id);
      logger.info("notification email verified", { requestId: requestIdOf(reply) });
      return reply.send({ data: { email: row.notification_email, verified: true }, meta: { requestId: requestIdOf(reply) } });
    }
  );

  app.delete("/v1/me/email", async (req, reply) => {
    if (gate(reply)) return;
    const user = await requireUser(req, reply);
    if (!user) return;
    await profileRepo.setNotificationEmail(user.id, null);
    return reply.send({ data: { email: null, verified: false }, meta: { requestId: requestIdOf(reply) } });
  });
}
