import type { JsonValue, Sql } from "../client.js";

export type WebhookStatus = "ACTIVE" | "DEGRADED" | "DISABLED";

export const WEBHOOK_EVENT_TYPES = [
  "monitor.threat.created",
  "correlation.appeared",
  "correlation.increased",
  "correlation.decreased",
  "correlation.disappeared"
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface DeveloperWebhookRow {
  id: string;
  user_id: string;
  url: string;
  status: WebhookStatus;
  event_types: unknown;
  secret_encrypted: string;
  secret_nonce: string;
  secret_key_version: string;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  failure_count: number;
  disabled_at: string | null;
  disabled_reason: string | null;
}

export interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  status: string;
  status_code: number | null;
  duration_ms: number | null;
  next_retry_at: string | null;
  error_excerpt: string | null;
  created_at: string;
}

export interface WebhookRepo {
  create(input: {
    userId: string;
    url: string;
    eventTypes: WebhookEventType[];
    secretEncrypted: string;
    secretNonce: string;
    secretKeyVersion: string;
  }): Promise<DeveloperWebhookRow>;
  listForUser(userId: string): Promise<DeveloperWebhookRow[]>;
  /** Active endpoints, for the D11 `webhooks.active` entitlement. */
  countActiveForUser(userId: string): Promise<number>;
  getForUser(userId: string, id: string): Promise<DeveloperWebhookRow | null>;
  getById(id: string): Promise<DeveloperWebhookRow | null>;
  updateForUser(userId: string, id: string, patch: { url?: string; eventTypes?: WebhookEventType[]; status?: WebhookStatus; disabledReason?: string | null }): Promise<DeveloperWebhookRow | null>;
  /** Rotates the secret (encrypted-at-rest) for a webhook. */
  rotateSecret(userId: string, id: string, input: { secretEncrypted: string; secretNonce: string; secretKeyVersion: string }): Promise<DeveloperWebhookRow | null>;
  deleteForUser(userId: string, id: string): Promise<boolean>;
  recordDelivery(input: {
    webhookId: string;
    eventId: string;
    eventType: string;
    attempt: number;
    status: string;
    statusCode: number | null;
    durationMs: number | null;
    nextRetryAt: string | null;
    errorExcerpt: string | null;
  }): Promise<void>;
  /** Marks a delivery outcome on the webhook row (success/failure/disable).
   *  Transient failures increment failure_count and degrade at 3; when the
   *  count reaches `disableAfterFailures` the webhook is DISABLED so a
   *  persistently broken endpoint stops consuming retries (D6-J §56). */
  markOutcome(webhookId: string, outcome: { ok: boolean; disable?: boolean; reason?: string; disableAfterFailures?: number }): Promise<void>;
  activeDeliverableWebhooks(): Promise<DeveloperWebhookRow[]>;
}

/** Webhook repository, see docs/d6-block2.md (D6-H). */
export function createWebhookRepo(sql: Sql): WebhookRepo {
  return {
    async create(input) {
      const [row] = await sql<DeveloperWebhookRow[]>`
        insert into developer_webhooks (
          user_id, url, event_types, secret_encrypted, secret_nonce, secret_key_version
        )
        values (
          ${input.userId}, ${input.url}, ${sql.json(input.eventTypes as unknown as JsonValue)},
          ${input.secretEncrypted}, ${input.secretNonce}, ${input.secretKeyVersion}
        )
        returning id::text, user_id::text, url, status, event_types,
          secret_encrypted, secret_nonce, secret_key_version, created_at, updated_at,
          last_success_at, last_failure_at, failure_count, disabled_at, disabled_reason
      `;
      if (!row) throw new Error("webhook insert returned no row");
      return row;
    },

    async listForUser(userId) {
      return sql<DeveloperWebhookRow[]>`
        select id::text, user_id::text, url, status, event_types,
          secret_encrypted, secret_nonce, secret_key_version, created_at, updated_at,
          last_success_at, last_failure_at, failure_count, disabled_at, disabled_reason
        from developer_webhooks
        where user_id = ${userId}
        order by created_at desc
      `;
    },

    async countActiveForUser(userId) {
      const [row] = await sql<Array<{ count: string }>>`
        select count(*)::text as count
        from developer_webhooks
        where user_id = ${userId} and status = 'ACTIVE'
      `;
      return row ? Number(row.count) : 0;
    },

    async getForUser(userId, id) {
      const [row] = await sql<DeveloperWebhookRow[]>`
        select id::text, user_id::text, url, status, event_types,
          secret_encrypted, secret_nonce, secret_key_version, created_at, updated_at,
          last_success_at, last_failure_at, failure_count, disabled_at, disabled_reason
        from developer_webhooks
        where user_id = ${userId} and id = ${id}
        limit 1
      `;
      return row ?? null;
    },

    async getById(id) {
      const [row] = await sql<DeveloperWebhookRow[]>`
        select id::text, user_id::text, url, status, event_types,
          secret_encrypted, secret_nonce, secret_key_version, created_at, updated_at,
          last_success_at, last_failure_at, failure_count, disabled_at, disabled_reason
        from developer_webhooks
        where id = ${id}
        limit 1
      `;
      return row ?? null;
    },

    async updateForUser(userId, id, patch) {
      const [row] = await sql<DeveloperWebhookRow[]>`
        update developer_webhooks
        set url = coalesce(${patch.url ?? null}, url),
            event_types = coalesce(${patch.eventTypes ? sql.json(patch.eventTypes as unknown as JsonValue) : sql`event_types`}, event_types),
            status = coalesce(${patch.status ?? null}, status),
            disabled_reason = ${patch.disabledReason === undefined ? sql`disabled_reason` : patch.disabledReason},
            disabled_at = case when ${patch.status ?? null} = 'DISABLED' then coalesce(disabled_at, now())
                               when ${patch.status ?? null} = 'ACTIVE' then null
                               else disabled_at end,
            failure_count = case when ${patch.status ?? null} = 'ACTIVE' then 0 else failure_count end,
            updated_at = now()
        where user_id = ${userId} and id = ${id}
        returning id::text, user_id::text, url, status, event_types,
          secret_encrypted, secret_nonce, secret_key_version, created_at, updated_at,
          last_success_at, last_failure_at, failure_count, disabled_at, disabled_reason
      `;
      return row ?? null;
    },

    async rotateSecret(userId, id, input) {
      const [row] = await sql<DeveloperWebhookRow[]>`
        update developer_webhooks
        set secret_encrypted = ${input.secretEncrypted},
            secret_nonce = ${input.secretNonce},
            secret_key_version = ${input.secretKeyVersion},
            updated_at = now()
        where user_id = ${userId} and id = ${id}
        returning id::text, user_id::text, url, status, event_types,
          secret_encrypted, secret_nonce, secret_key_version, created_at, updated_at,
          last_success_at, last_failure_at, failure_count, disabled_at, disabled_reason
      `;
      return row ?? null;
    },

    async deleteForUser(userId, id) {
      const result = await sql`
        delete from developer_webhooks
        where user_id = ${userId} and id = ${id}
      `;
      return result.count > 0;
    },

    async recordDelivery(input) {
      await sql`
        insert into webhook_deliveries (
          webhook_id, event_id, event_type, attempt, status, status_code,
          duration_ms, next_retry_at, error_excerpt
        )
        values (
          ${input.webhookId}, ${input.eventId}, ${input.eventType}, ${input.attempt},
          ${input.status}, ${input.statusCode}, ${input.durationMs},
          ${input.nextRetryAt}, ${input.errorExcerpt}
        )
        on conflict (webhook_id, event_id, attempt) do nothing
      `;
    },

    async markOutcome(webhookId, outcome) {
      if (outcome.ok) {
        await sql`
          update developer_webhooks
          set last_success_at = now(), last_failure_at = null, failure_count = 0,
              status = 'ACTIVE', disabled_at = null, disabled_reason = null,
              updated_at = now()
          where id = ${webhookId}
        `;
        return;
      }
      if (outcome.disable) {
        await sql`
          update developer_webhooks
          set last_failure_at = now(), failure_count = failure_count + 1,
              status = 'DISABLED', disabled_at = now(), disabled_reason = ${outcome.reason ?? "permanent failure"},
              updated_at = now()
          where id = ${webhookId}
        `;
        return;
      }
      await sql`
        update developer_webhooks
        set last_failure_at = now(), failure_count = failure_count + 1,
            status = case when failure_count + 1 >= 3 then 'DEGRADED' else status end,
            updated_at = now()
        where id = ${webhookId}
      `;
      // D6-J §56: a persistently broken endpoint must not retry forever.
      // Once failure_count reaches the configured cap the webhook is
      // disabled outright (bounded failure storm).
      if (outcome.disableAfterFailures && outcome.disableAfterFailures > 0) {
        await sql`
          update developer_webhooks
          set status = 'DISABLED', disabled_at = now(),
              disabled_reason = 'disabled after repeated failures',
              updated_at = now()
          where id = ${webhookId} and failure_count >= ${outcome.disableAfterFailures}
        `;
      }
    },

    async activeDeliverableWebhooks() {
      return sql<DeveloperWebhookRow[]>`
        select id::text, user_id::text, url, status, event_types,
          secret_encrypted, secret_nonce, secret_key_version, created_at, updated_at,
          last_success_at, last_failure_at, failure_count, disabled_at, disabled_reason
        from developer_webhooks
        where status in ('ACTIVE', 'DEGRADED')
      `;
    }
  };
}
