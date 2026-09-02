import type { Sql } from "../client.js";

export interface ProfileEmailRow {
  notification_email: string | null;
  notification_email_verified_at: string | null;
  email_verification_code_hash: string | null;
  email_verification_code_expires_at: string | null;
  email_verification_attempts: number;
}

export interface ProfileRepo {
  /** Reads the notification-email destination state for a user. */
  getEmailForUser(userId: string): Promise<ProfileEmailRow | null>;
  /**
   * Sets the notification destination (always unverified until the
   * code-verification flow confirms it, D6-I1 §8). Resets verification.
   */
  setNotificationEmail(userId: string, email: string | null): Promise<void>;
  /** Stores a verification code digest + expiry for a pending email. */
  storeEmailVerificationCode(userId: string, codeHash: string, expiresAt: string): Promise<void>;
  /** Consumes a verification attempt (bounded attempts). Returns the row. */
  consumeEmailVerificationAttempt(userId: string): Promise<ProfileEmailRow | null>;
  /** Marks the current notification_email verified (atomic guard). */
  markEmailVerified(userId: string): Promise<void>;
}

/** Profile repository for notification-email destinations, see
 *  docs/milestone-d6.md (D6-I1 §7-§8). Email is a notification destination
 *  ONLY — wallet-only authentication stays canonical. */
export function createProfileRepo(sql: Sql): ProfileRepo {
  return {
    async getEmailForUser(userId) {
      const [row] = await sql<ProfileEmailRow[]>`
        select notification_email, notification_email_verified_at,
          email_verification_code_hash, email_verification_code_expires_at,
          email_verification_attempts
        from profiles where id = ${userId} limit 1
      `;
      return row ?? null;
    },

    async setNotificationEmail(userId, email) {
      await sql`
        update profiles
        set notification_email = ${email},
            notification_email_verified_at = null,
            email_verification_code_hash = null,
            email_verification_code_expires_at = null,
            email_verification_attempts = 0,
            updated_at = now()
        where id = ${userId}
      `;
    },

    async storeEmailVerificationCode(userId, codeHash, expiresAt) {
      await sql`
        update profiles
        set email_verification_code_hash = ${codeHash},
            email_verification_code_expires_at = ${expiresAt}::timestamptz,
            email_verification_attempts = 0,
            updated_at = now()
        where id = ${userId}
      `;
    },

    async consumeEmailVerificationAttempt(userId) {
      const [row] = await sql<ProfileEmailRow[]>`
        update profiles
        set email_verification_attempts = email_verification_attempts + 1
        where id = ${userId}
        returning notification_email, notification_email_verified_at,
          email_verification_code_hash, email_verification_code_expires_at,
          email_verification_attempts
      `;
      return row ?? null;
    },

    async markEmailVerified(userId) {
      await sql`
        update profiles
        set notification_email_verified_at = now(),
            email_verification_code_hash = null,
            email_verification_code_expires_at = null,
            email_verification_attempts = 0,
            updated_at = now()
        where id = ${userId}
      `;
    }
  };
}
