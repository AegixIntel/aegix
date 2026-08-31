import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";

/**
 * Email provider abstraction, see docs/milestone-d5.md (D5-J §49-§51).
 *
 * Business logic depends only on this interface — no vendor is hardcoded.
 * Providers:
 * - "smtp": real transactional delivery via SMTP (nodemailer). Secrets come
 *   only from server-side config (EMAIL_SMTP_*), never from the client.
 * - "console": structured log only (local development / tests).
 * - disabled: no-op.
 *
 * send() throws TransientEmailError for retryable failures (timeout, rate
 * limit, connection) and PermanentEmailError for non-retryable ones (invalid
 * recipient, auth rejected). The delivery pipeline retries only transient
 * failures and keeps notification idempotency via the status guard.
 */

export interface EmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface EmailProvider {
  isConfigured(): boolean;
  send(input: EmailInput): Promise<void>;
}

/** Retryable failure: timeout, rate limit, temporary connection issue. */
export class TransientEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientEmailError";
  }
}

/** Permanent failure: invalid recipient, rejected auth, bad envelope. */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEmailError";
  }
}

const TRANSIENT_MARKERS = ["timeout", "timed out", "rate", "quota", "temporar", "connect", "socket", "greeting", "4", "ETIMEDOUT", "ECONN"];
const PERMANENT_MARKERS = ["invalid", "rejected", "auth", "unknown user", "no such", "bounce", "spam", "denied", "5"];

/** Classifies a nodemailer failure as transient or permanent (D5-J §50). */
export function classifyEmailError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const code = (err as { code?: string }).code ?? "";
  if (PERMANENT_MARKERS.some((m) => lower.includes(m.toLowerCase())) && !TRANSIENT_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
    return new PermanentEmailError(message);
  }
  if (TRANSIENT_MARKERS.some((m) => lower.includes(m.toLowerCase()) || code.includes(m))) {
    return new TransientEmailError(message);
  }
  // SMTP response codes: 4xx transient, 5xx permanent.
  const smtpCode = /(\d{3})/.exec(message)?.[1];
  if (smtpCode) {
    return smtpCode.startsWith("4") ? new TransientEmailError(message) : new PermanentEmailError(message);
  }
  // Unknown failures are treated as transient — retrying is safer than
  // silently dropping a notification.
  return new TransientEmailError(message);
}

/** Real transactional provider via SMTP (D5-J §49). */
class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: AppConfig, private readonly logger: AegixLogger) {
    this.from = config.EMAIL_FROM;
    this.transporter = nodemailer.createTransport({
      host: config.EMAIL_SMTP_HOST,
      port: config.EMAIL_SMTP_PORT,
      secure: config.EMAIL_SMTP_SECURE,
      auth: config.EMAIL_SMTP_USER
        ? { user: config.EMAIL_SMTP_USER, pass: config.EMAIL_SMTP_PASS }
        : undefined,
      connectionTimeout: config.EMAIL_SMTP_TIMEOUT_MS,
      socketTimeout: config.EMAIL_SMTP_TIMEOUT_MS,
      greetingTimeout: config.EMAIL_SMTP_TIMEOUT_MS
    });
  }

  isConfigured(): boolean {
    return true;
  }

  async send(input: EmailInput): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: input.to,
        subject: input.subject,
        text: input.body
      });
      this.logger.info("email sent", { channel: "email", toRef: `${input.to.slice(0, 8)}…` });
    } catch (err) {
      const classified = classifyEmailError(err);
      // Never log secrets or full recipient addresses (D5-L §99).
      this.logger.warn("email send failed", {
        channel: "email",
        toRef: `${input.to.slice(0, 8)}…`,
        error: classified.message.slice(0, 200),
        transient: classified instanceof TransientEmailError
      });
      throw classified;
    }
  }
}

/** Console/log-only provider used when SMTP is not configured (local dev). */
class ConsoleEmailProvider implements EmailProvider {
  constructor(private readonly logger: AegixLogger) {}

  isConfigured(): boolean {
    return true;
  }

  async send(input: EmailInput): Promise<void> {
    this.logger.info("email would be sent", {
      channel: "email",
      toRef: `${input.to.slice(0, 8)}…`,
      subject: input.subject,
      bodyPreview: input.body.slice(0, 200)
    });
  }
}

/** No-op provider used when email is disabled. */
class DisabledEmailProvider implements EmailProvider {
  isConfigured(): boolean {
    return false;
  }
  async send(): Promise<void> {
    // never reached
  }
}

export function createEmailProvider(config: AppConfig, logger: AegixLogger): EmailProvider {
  if (!config.EMAIL_ENABLED) {
    return new DisabledEmailProvider();
  }
  if (config.EMAIL_PROVIDER === "smtp") {
    if (!config.EMAIL_SMTP_HOST) {
      logger.error("EMAIL_PROVIDER=smtp requires EMAIL_SMTP_HOST");
      return new DisabledEmailProvider();
    }
    return new SmtpEmailProvider(config, logger);
  }
  return new ConsoleEmailProvider(logger);
}
