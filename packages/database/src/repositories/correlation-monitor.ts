import type { JsonValue, Sql } from "../client.js";

export interface CorrelationBaselineRow {
  id: string;
  monitor_id: string;
  wallet_a: string;
  wallet_b: string;
  correlation_score: number;
  confidence: number;
  classification: string;
  correlation_result_id: string | null;
  evidence_families: unknown;
  engine_version: string;
  created_at: string;
}

export interface CorrelationThreatEventRow {
  id: string;
  monitor_id: string;
  user_id: string;
  wallet_id: string;
  related_wallet: string;
  event_type: string;
  severity: string;
  confidence: number;
  previous_score: number | null;
  new_score: number | null;
  previous_confidence: number | null;
  new_confidence: number | null;
  evidence: unknown;
  limitations: unknown;
  engine_version: string;
  fingerprint: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  created_at: string;
}

export interface MonitorCorrelationRepo {
  listBaselines(monitorId: string): Promise<CorrelationBaselineRow[]>;
  upsertBaseline(input: {
    monitorId: string;
    walletA: string;
    walletB: string;
    correlationScore: number;
    confidence: number;
    classification: string;
    correlationResultId: string | null;
    evidenceFamilies: unknown;
    engineVersion: string;
  }): Promise<CorrelationBaselineRow>;
  /**
   * Upserts a correlation threat event by (monitor, fingerprint): the
   * fingerprint is the cooldown anchor — a repeated event increments
   * occurrence_count instead of creating a duplicate (§72-§73).
   */
  upsertEvent(input: {
    monitorId: string;
    userId: string;
    walletId: string;
    relatedWallet: string;
    eventType: string;
    severity: string;
    confidence: number;
    previousScore: number | null;
    newScore: number | null;
    previousConfidence: number | null;
    newConfidence: number | null;
    evidence: unknown;
    limitations: unknown;
    engineVersion: string;
    fingerprint: string;
  }): Promise<CorrelationThreatEventRow>;
  recentEvent(monitorId: string, fingerprint: string, since: string): Promise<CorrelationThreatEventRow | null>;
  listEventsForMonitor(monitorId: string, limit: number): Promise<CorrelationThreatEventRow[]>;
  listEventsForUser(userId: string, limit: number): Promise<CorrelationThreatEventRow[]>;
}

/** Monitor correlation baseline + event repository, see docs/d6-block2.md (D6-F). */
export function createMonitorCorrelationRepo(sql: Sql): MonitorCorrelationRepo {
  return {
    async listBaselines(monitorId) {
      return sql<CorrelationBaselineRow[]>`
        select id::text, monitor_id::text, wallet_a, wallet_b, correlation_score,
          confidence::text::numeric::float8 as confidence, classification,
          correlation_result_id::text, evidence_families, engine_version, created_at
        from monitor_correlation_baselines
        where monitor_id = ${monitorId}
      `;
    },

    async upsertBaseline(input) {
      const [row] = await sql<CorrelationBaselineRow[]>`
        insert into monitor_correlation_baselines (
          monitor_id, wallet_a, wallet_b, correlation_score, confidence,
          classification, correlation_result_id, evidence_families, engine_version
        )
        values (
          ${input.monitorId}, ${input.walletA}, ${input.walletB}, ${input.correlationScore},
          ${input.confidence}, ${input.classification}, ${input.correlationResultId},
          ${sql.json(input.evidenceFamilies as unknown as JsonValue)}, ${input.engineVersion}
        )
        on conflict (monitor_id, wallet_a, wallet_b) do update set
          correlation_score = excluded.correlation_score,
          confidence = excluded.confidence,
          classification = excluded.classification,
          correlation_result_id = coalesce(excluded.correlation_result_id, monitor_correlation_baselines.correlation_result_id),
          evidence_families = excluded.evidence_families,
          engine_version = excluded.engine_version,
          created_at = now()
        returning id::text, monitor_id::text, wallet_a, wallet_b, correlation_score,
          confidence::text::numeric::float8 as confidence, classification,
          correlation_result_id::text, evidence_families, engine_version, created_at
      `;
      if (!row) throw new Error("correlation baseline upsert returned no row");
      return row;
    },

    async upsertEvent(input) {
      const [row] = await sql<CorrelationThreatEventRow[]>`
        insert into correlation_threat_events (
          monitor_id, user_id, wallet_id, related_wallet, event_type, severity,
          confidence, previous_score, new_score, previous_confidence, new_confidence,
          evidence, limitations, engine_version, fingerprint
        )
        values (
          ${input.monitorId}, ${input.userId}, ${input.walletId}, ${input.relatedWallet},
          ${input.eventType}, ${input.severity}, ${input.confidence},
          ${input.previousScore}, ${input.newScore}, ${input.previousConfidence}, ${input.newConfidence},
          ${sql.json(input.evidence as unknown as JsonValue)}, ${sql.json(input.limitations as unknown as JsonValue)},
          ${input.engineVersion}, ${input.fingerprint}
        )
        on conflict (monitor_id, fingerprint) do update set
          last_seen_at = now(),
          occurrence_count = correlation_threat_events.occurrence_count + 1,
          previous_score = coalesce(excluded.previous_score, correlation_threat_events.previous_score),
          new_score = excluded.new_score,
          previous_confidence = coalesce(excluded.previous_confidence, correlation_threat_events.previous_confidence),
          new_confidence = excluded.new_confidence,
          evidence = excluded.evidence,
          severity = excluded.severity,
          confidence = excluded.confidence
        returning id::text, monitor_id::text, user_id::text, wallet_id::text, related_wallet,
          event_type, severity, confidence::text::numeric::float8 as confidence,
          previous_score, new_score, previous_confidence::text::numeric::float8 as previous_confidence,
          new_confidence::text::numeric::float8 as new_confidence, evidence, limitations,
          engine_version, fingerprint, first_seen_at, last_seen_at, occurrence_count, created_at
      `;
      if (!row) throw new Error("correlation threat event upsert returned no row");
      return row;
    },

    async recentEvent(monitorId, fingerprint, since) {
      const [row] = await sql<CorrelationThreatEventRow[]>`
        select id::text, monitor_id::text, user_id::text, wallet_id::text, related_wallet,
          event_type, severity, confidence::text::numeric::float8 as confidence,
          previous_score, new_score, previous_confidence::text::numeric::float8 as previous_confidence,
          new_confidence::text::numeric::float8 as new_confidence, evidence, limitations,
          engine_version, fingerprint, first_seen_at, last_seen_at, occurrence_count, created_at
        from correlation_threat_events
        where monitor_id = ${monitorId} and fingerprint = ${fingerprint} and last_seen_at >= ${since}::timestamptz
        limit 1
      `;
      return row ?? null;
    },

    async listEventsForMonitor(monitorId, limit) {
      return sql<CorrelationThreatEventRow[]>`
        select id::text, monitor_id::text, user_id::text, wallet_id::text, related_wallet,
          event_type, severity, confidence::text::numeric::float8 as confidence,
          previous_score, new_score, previous_confidence::text::numeric::float8 as previous_confidence,
          new_confidence::text::numeric::float8 as new_confidence, evidence, limitations,
          engine_version, fingerprint, first_seen_at, last_seen_at, occurrence_count, created_at
        from correlation_threat_events
        where monitor_id = ${monitorId}
        order by created_at desc
        limit ${limit}
      `;
    },

    async listEventsForUser(userId, limit) {
      return sql<CorrelationThreatEventRow[]>`
        select id::text, monitor_id::text, user_id::text, wallet_id::text, related_wallet,
          event_type, severity, confidence::text::numeric::float8 as confidence,
          previous_score, new_score, previous_confidence::text::numeric::float8 as previous_confidence,
          new_confidence::text::numeric::float8 as new_confidence, evidence, limitations,
          engine_version, fingerprint, first_seen_at, last_seen_at, occurrence_count, created_at
        from correlation_threat_events
        where user_id = ${userId}
        order by created_at desc
        limit ${limit}
      `;
    }
  };
}
