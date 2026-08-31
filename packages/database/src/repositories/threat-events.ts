import type { Sql } from "../client.js";

/** postgres.js JSON payload — the repo boundary accepts plain JSON values. */
type JsonInput =
  | null
  | string
  | number
  | boolean
  | JsonInput[]
  | { [key: string]: JsonInput | undefined };

export interface ThreatEventRow {
  id: string;
  monitor_id: string;
  user_id: string;
  wallet_id: string;
  diff_id: string | null;
  event_type: string;
  severity: string;
  confidence: string;
  subject: string;
  fingerprint: string;
  title: string;
  summary: string;
  explanation: string;
  evidence: unknown;
  state: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: string;
  created_at: string;
}

export interface ThreatEventRepo {
  /** Idempotent per (monitor, fingerprint): bumps occurrence on repeat. */
  upsertByFingerprint(input: {
    monitorId: string;
    userId: string;
    walletId: string;
    diffId: string | null;
    eventType: string;
    severity: string;
    confidence: number;
    subject: string;
    fingerprint: string;
    title: string;
    summary: string;
    explanation: string;
    evidence: Record<string, unknown>;
  }): Promise<ThreatEventRow>;
  getById(id: string): Promise<ThreatEventRow | null>;
  listForMonitor(monitorId: string, limit: number): Promise<ThreatEventRow[]>;
  listForUser(userId: string, limit: number): Promise<ThreatEventRow[]>;
  recentForMonitor(monitorId: string, fingerprint: string, since: string): Promise<ThreatEventRow | null>;
  acknowledge(userId: string, eventId: string): Promise<boolean>;
  expireOld(olderThan: string): Promise<number>;
}

/** Threat event repository, see docs/milestone-d4.md (D4-D). */
export function createThreatEventRepo(sql: Sql): ThreatEventRepo {
  return {
    async upsertByFingerprint(input) {
      const [row] = await sql<ThreatEventRow[]>`
        insert into threat_events (
          monitor_id, user_id, wallet_id, diff_id, event_type, severity,
          confidence, subject, fingerprint, title, summary, explanation, evidence
        )
        values (
          ${input.monitorId}, ${input.userId}, ${input.walletId}, ${input.diffId},
          ${input.eventType}, ${input.severity}, ${input.confidence},
          ${input.subject}, ${input.fingerprint}, ${input.title},
          ${input.summary}, ${input.explanation}, ${sql.json(input.evidence as JsonInput)}
        )
        on conflict (monitor_id, fingerprint) do update set
          last_seen_at = now(),
          occurrence_count = threat_events.occurrence_count + 1,
          state = case when threat_events.state = 'RESOLVED' then 'RESOLVED' else 'OPEN' end,
          diff_id = coalesce(excluded.diff_id, threat_events.diff_id),
          severity = excluded.severity,
          confidence = excluded.confidence,
          title = excluded.title,
          summary = excluded.summary,
          explanation = excluded.explanation,
          evidence = excluded.evidence
        returning *
      `;
      if (!row) throw new Error("threat event upsert returned no row");
      return row;
    },

    async getById(id) {
      const [row] = await sql<ThreatEventRow[]>`
        select * from threat_events where id = ${id}
      `;
      return row ?? null;
    },

    async listForMonitor(monitorId, limit) {
      return sql<ThreatEventRow[]>`
        select * from threat_events
        where monitor_id = ${monitorId}
        order by created_at desc
        limit ${limit}
      `;
    },

    async listForUser(userId, limit) {
      return sql<ThreatEventRow[]>`
        select * from threat_events
        where user_id = ${userId}
        order by created_at desc
        limit ${limit}
      `;
    },

    async recentForMonitor(monitorId, fingerprint, since) {
      const [row] = await sql<ThreatEventRow[]>`
        select * from threat_events
        where monitor_id = ${monitorId} and fingerprint = ${fingerprint}
          and last_seen_at >= ${since}
        limit 1
      `;
      return row ?? null;
    },

    async acknowledge(userId, eventId) {
      const result = await sql`
        update threat_events
        set state = 'ACKNOWLEDGED'
        where user_id = ${userId} and id = ${eventId}
      `;
      return result.count > 0;
    },

    async expireOld(olderThan) {
      const result = await sql`
        update threat_events
        set state = 'EXPIRED'
        where state = 'OPEN' and last_seen_at < ${olderThan}
      `;
      return result.count;
    }
  };
}
