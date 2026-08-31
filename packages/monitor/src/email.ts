import type { AppConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";

/**
 * Email provider abstraction, see docs/milestone-d4.md (D4-F §50-§51).
 *
 * Business logic depends only on this interface — no vendor is hardcoded.
 * The beta ships with a console provider (structured log only) behind the
 * ENABLE_EMAIL_NOTIFICATIONS flag; a real SMTP/API provider is a drop-in.
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

/** Console/log-only provider used in public beta. */
class ConsoleEmailProvider implements EmailProvider {
  constructor(private readonly logger: AegixLogger) {}

  isConfigured(): boolean {
    return true;
  }

  async send(input: EmailInput): Promise<void> {
    // Recipients are the user's own address; labels are private metadata and
    // are never included (D4-F §55). Wallet addresses are public blockchain
    // data and are redacted to short form by callers.
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
  if (config.ENABLE_EMAIL_NOTIFICATIONS) {
    return new ConsoleEmailProvider(logger);
  }
  return new DisabledEmailProvider();
}
