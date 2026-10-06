import type { JsonValue, Sql } from "../client.js";

export interface ObservationPointRow {
  series_key: string;
  event_time: string;
  value: number;
  source: string;
  observed_at: string;
}

export interface StoredSignalRow {
  type: string;
  severity: number;
  confidence: number;
  title: string;
  summary: string;
  evidence: unknown;
  engineVersion: string;
}

export interface StoredCaptureRow {
  id: string;
  observed_at: string;
  engine_version: string;
  quality_grade: string;
  provider_status: string;
  signals: StoredSignalRow[];
}

/** What a capture is of: a market asset, a news topic, or a sector or commodity fund. */
export type CaptureDomain = "MARKET" | "NARRATIVE" | "SECTOR";

/** A capture that held at least one signal, with the subject it belongs to. */
export interface ContextCaptureRow extends StoredCaptureRow {
  domain: CaptureDomain;
  subject: string;
}

export interface SignalCaptureWrite {
  domain: CaptureDomain;
  subject: string;
  bucketStart: string;
  engineVersion: string;
  provider: string;
  providerStatus: string;
  qualityGrade: string;
  signals: StoredSignalRow[];
}

export interface ObservationRepo {
  /** Appends points; a point already held for (series, event time, source) is left as first observed. Returns rows added. */
  appendPoints(points: Array<{ seriesKey: string; eventTime: string; value: number; source: string }>): Promise<number>;
  /** Points with event_time in [from, to), oldest first. */
  pointsBetween(seriesKeys: string[], from: string, to: string): Promise<ObservationPointRow[]>;
  /** Stores one capture and its signals atomically. False when this bucket was already captured. */
  recordCapture(capture: SignalCaptureWrite): Promise<boolean>;
  /** Captures stored in [from, before) — strictly before the lock. */
  capturesBetween(domain: CaptureDomain, subject: string, from: string, before: string): Promise<StoredCaptureRow[]>;
  /**
   * Captures of whole domains stored in [from, before) that held a signal,
   * oldest first: what the news and the funds were doing around a subject.
   */
  signalledCapturesBetween(domains: CaptureDomain[], from: string, before: string, limit: number): Promise<ContextCaptureRow[]>;
  /** Completed wallet analyses in [from, before), with the signals each one stored. */
  walletCapturesBetween(chain: string, address: string, from: string, before: string): Promise<StoredCaptureRow[]>;
}

/**
 * Observation ledger and signal captures, see docs/milestone-d14-rewind-discovery.md.
 * Append-only: the tables reject UPDATE and DELETE, and stamp observed_at
 * themselves, so this repository has no way to rewrite or backdate a row.
 */
export function createObservationRepo(sql: Sql): ObservationRepo {
  return {
    async appendPoints(points) {
      if (points.length === 0) return 0;
      const rows = await sql`
        insert into observation_points (series_key, event_time, value, source)
        select * from unnest(
          ${points.map((p) => p.seriesKey)}::text[],
          ${points.map((p) => p.eventTime)}::timestamptz[],
          ${points.map((p) => String(p.value))}::numeric[],
          ${points.map((p) => p.source)}::text[]
        )
        on conflict (series_key, event_time, source) do nothing
        returning id
      `;
      return rows.length;
    },

    async pointsBetween(seriesKeys, from, to) {
      if (seriesKeys.length === 0) return [];
      return sql<ObservationPointRow[]>`
        select series_key, event_time, value::float8 as value, source, observed_at
        from observation_points
        where series_key = any(${seriesKeys}) and event_time >= ${from}::timestamptz and event_time < ${to}::timestamptz
        order by series_key asc, event_time asc, observed_at asc
      `;
    },

    async recordCapture(capture) {
      return sql.begin(async (tx) => {
        const [row] = await tx<Array<{ id: string }>>`
          insert into signal_captures (
            domain, subject, bucket_start, engine_version, provider, provider_status, quality_grade, signal_count
          ) values (
            ${capture.domain}, ${capture.subject}, ${capture.bucketStart}, ${capture.engineVersion},
            ${capture.provider}, ${capture.providerStatus}, ${capture.qualityGrade}, ${capture.signals.length}
          )
          on conflict (domain, subject, bucket_start, engine_version) do nothing
          returning id
        `;
        if (!row) return false;
        for (const s of capture.signals) {
          await tx`
            insert into signal_snapshots (
              capture_id, signal_type, severity, confidence, title, summary, evidence, engine_version
            ) values (
              ${row.id}, ${s.type}, ${s.severity}, ${s.confidence}, ${s.title}, ${s.summary},
              ${tx.json(s.evidence as JsonValue)}, ${s.engineVersion}
            )
          `;
        }
        return true;
      });
    },

    async capturesBetween(domain, subject, from, before) {
      return sql<StoredCaptureRow[]>`
        select c.id::text, c.observed_at, c.engine_version, c.quality_grade, c.provider_status,
          coalesce(json_agg(json_build_object(
            'type', s.signal_type, 'severity', s.severity, 'confidence', s.confidence::float8,
            'title', s.title, 'summary', s.summary, 'evidence', s.evidence, 'engineVersion', s.engine_version
          ) order by s.severity desc, s.signal_type asc) filter (where s.id is not null), '[]'::json) as signals
        from signal_captures c
        left join signal_snapshots s on s.capture_id = c.id
        where c.domain = ${domain} and c.subject = ${subject}
          and c.observed_at >= ${from}::timestamptz and c.observed_at < ${before}::timestamptz
        group by c.id
        order by c.observed_at asc
      `;
    },

    async signalledCapturesBetween(domains, from, before, limit) {
      if (domains.length === 0) return [];
      return sql<ContextCaptureRow[]>`
        select c.id::text, c.domain, c.subject, c.observed_at, c.engine_version, c.quality_grade, c.provider_status,
          json_agg(json_build_object(
            'type', s.signal_type, 'severity', s.severity, 'confidence', s.confidence::float8,
            'title', s.title, 'summary', s.summary, 'evidence', s.evidence, 'engineVersion', s.engine_version
          ) order by s.severity desc, s.signal_type asc) as signals
        from signal_captures c
        join signal_snapshots s on s.capture_id = c.id
        where c.domain = any(${domains}) and c.signal_count > 0
          and c.observed_at >= ${from}::timestamptz and c.observed_at < ${before}::timestamptz
        group by c.id
        order by c.observed_at asc
        limit ${limit}
      `;
    },

    async walletCapturesBetween(chain, address, from, before) {
      return sql<StoredCaptureRow[]>`
        select j.id::text, j.completed_at as observed_at, coalesce(j.engine_version, 'unknown') as engine_version,
          coalesce(j.data_quality->>'grade', 'UNKNOWN') as quality_grade, 'OK' as provider_status,
          coalesce(json_agg(json_build_object(
            'type', s.signal_type, 'severity', s.severity, 'confidence', s.confidence::float8,
            'title', s.title, 'summary', coalesce(s.summary, ''), 'evidence', coalesce(s.evidence_json, '[]'::jsonb),
            'engineVersion', coalesce(s.engine_version, 'unknown')
          ) order by s.severity desc, s.signal_type asc) filter (where s.id is not null), '[]'::json) as signals
        from analysis_jobs j
        join wallets w on w.id = j.wallet_id
        left join exposure_signals s on s.analysis_id = j.id
        where w.chain = ${chain} and w.address = ${address} and j.status = 'READY'
          and j.completed_at >= ${from}::timestamptz and j.completed_at < ${before}::timestamptz
        group by j.id
        order by j.completed_at asc
      `;
    }
  };
}
