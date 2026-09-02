import type { Sql } from "../client.js";

export interface AlertRulesRow {
  id: string;
  monitor_id: string;
  minimum_severity: string;
  minimum_confidence: string;
  overall_score_delta_threshold: number;
  notify_new_entity: boolean;
  notify_new_attack_path: boolean;
  notify_behavior_change: boolean;
  notify_data_quality_degraded: boolean;
  cooldown_hours: number;
  /** D6-F §76: correlation alert knobs. */
  notify_correlation_change: boolean;
  correlation_min_score: number;
  correlation_min_confidence: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  monitor_id: string | null;
  event_id: string | null;
  channel: string;
  type: string;
  title: string;
  body: string;
  severity: string;
  read_at: string | null;
  status: string;
  idempotency_key: string;
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface MonitorAlertRulesRepo {
  createWithMonitor(monitorId: string, defaults: { minimumSeverity: string; minimumConfidence: number; overallScoreDeltaThreshold: number; cooldownHours: number }): Promise<AlertRulesRow>;
  getForMonitor(monitorId: string): Promise<AlertRulesRow | null>;
  updateForMonitor(monitorId: string, patch: Partial<AlertRulesRow>): Promise<AlertRulesRow | null>;
}

export interface NotificationRepo {
  /** Idempotent per idempotency_key — a retried delivery cannot duplicate. */
  insert(input: {
    userId: string;
    monitorId: string | null;
    eventId: string | null;
    channel: string;
    type: string;
    title: string;
    body: string;
    severity: string;
    idempotencyKey: string;
    status?: string;
  }): Promise<NotificationRow | null>;
  getById(id: string): Promise<NotificationRow | null>;
  listForUser(userId: string, limit: number): Promise<NotificationRow[]>;
  unreadCount(userId: string): Promise<number>;
  markRead(userId: string, notificationId: string): Promise<boolean>;
  markDelivered(id: string): Promise<boolean>;
  markFailed(id: string, error: string): Promise<void>;
  markSuppressed(id: string, error: string): Promise<void>;
}

/** Alert rules repository, see docs/milestone-d4.md (D4-E §42). */
export function createMonitorAlertRulesRepo(sql: Sql): MonitorAlertRulesRepo {
  return {
    async createWithMonitor(monitorId, defaults) {
      const [row] = await sql<AlertRulesRow[]>`
        insert into monitor_alert_rules (
          monitor_id, minimum_severity, minimum_confidence,
          overall_score_delta_threshold, cooldown_hours
        )
        values (
          ${monitorId}, ${defaults.minimumSeverity}, ${defaults.minimumConfidence},
          ${defaults.overallScoreDeltaThreshold}, ${defaults.cooldownHours}
        )
        on conflict (monitor_id) do nothing
        returning *
      `;
      if (row) return row;
      const [existing] = await sql<AlertRulesRow[]>`
        select * from monitor_alert_rules where monitor_id = ${monitorId} limit 1
      `;
      if (!existing) throw new Error("alert rules insert returned no row");
      return existing;
    },

    async getForMonitor(monitorId) {
      const [row] = await sql<AlertRulesRow[]>`
        select * from monitor_alert_rules where monitor_id = ${monitorId} limit 1
      `;
      return row ?? null;
    },

    async updateForMonitor(monitorId, patch) {
      const [row] = await sql<AlertRulesRow[]>`
        update monitor_alert_rules
        set minimum_severity = coalesce(${patch.minimum_severity ?? null}, minimum_severity),
            minimum_confidence = coalesce(${patch.minimum_confidence ?? null}, minimum_confidence),
            overall_score_delta_threshold = coalesce(${patch.overall_score_delta_threshold ?? null}, overall_score_delta_threshold),
            notify_new_entity = coalesce(${patch.notify_new_entity ?? null}, notify_new_entity),
            notify_new_attack_path = coalesce(${patch.notify_new_attack_path ?? null}, notify_new_attack_path),
            notify_behavior_change = coalesce(${patch.notify_behavior_change ?? null}, notify_behavior_change),
            notify_data_quality_degraded = coalesce(${patch.notify_data_quality_degraded ?? null}, notify_data_quality_degraded),
            cooldown_hours = coalesce(${patch.cooldown_hours ?? null}, cooldown_hours),
            updated_at = now()
        where monitor_id = ${monitorId}
        returning *
      `;
      return row ?? null;
    }
  };
}

/** Notification repository, see docs/milestone-d4.md (D4-F §49, §52-§54). */
export function createNotificationRepo(sql: Sql): NotificationRepo {
  return {
    async insert(input) {
      const [row] = await sql<NotificationRow[]>`
        insert into notifications (
          user_id, monitor_id, event_id, channel, type, title, body,
          severity, idempotency_key, status
        )
        values (
          ${input.userId}, ${input.monitorId}, ${input.eventId}, ${input.channel},
          ${input.type}, ${input.title}, ${input.body}, ${input.severity},
          ${input.idempotencyKey}, ${input.status ?? "PENDING"}
        )
        on conflict (idempotency_key) do nothing
        returning *
      `;
      return row ?? null;
    },

    async getById(id) {
      const [row] = await sql<NotificationRow[]>`
        select * from notifications where id = ${id}
      `;
      return row ?? null;
    },

    async listForUser(userId, limit) {
      return sql<NotificationRow[]>`
        select * from notifications
        where user_id = ${userId}
        order by created_at desc
        limit ${limit}
      `;
    },

    async unreadCount(userId) {
      const [row] = await sql<Array<{ count: string }>>`
        select count(*)::text as count from notifications
        where user_id = ${userId} and read_at is null
      `;
      return row ? Number(row.count) : 0;
    },

    async markRead(userId, notificationId) {
      const result = await sql`
        update notifications
        set read_at = now()
        where user_id = ${userId} and id = ${notificationId}
      `;
      return result.count > 0;
    },

    async markDelivered(id) {
      const result = await sql`
        update notifications
        set status = 'SENT', sent_at = now()
        where id = ${id} and status = 'PENDING'
      `;
      return result.count > 0;
    },

    async markFailed(id, error) {
      await sql`
        update notifications
        set status = 'FAILED', attempt_count = attempt_count + 1, last_error = ${error}
        where id = ${id}
      `;
    },

    async markSuppressed(id, error) {
      await sql`
        update notifications
        set status = 'SUPPRESSED', last_error = ${error}
        where id = ${id}
      `;
    }
  };
}
