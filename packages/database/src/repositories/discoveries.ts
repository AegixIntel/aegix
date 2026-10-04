import type { JsonValue, Sql } from "../client.js";

export interface DiscoveryRunWrite {
  engineVersion: string;
  epochEnd: string;
  windowHours: number;
  baselineHours: number;
  fdrLevel: number;
  method: string;
  seriesCount: number;
  hypothesesConsidered: number;
  hypothesesTested: number;
  rejections: number;
  tests: Array<{
    pairKey: string; seriesA: string; seriesB: string; lagHours: number; status: string; role: string | null;
    r: number | null; rBaseline: number | null; n: number; nEffective: number | null;
    pValue: number | null; qValue: number | null; rejected: boolean;
  }>;
  discoveries: Array<{
    pairKey: string; seriesA: string; seriesB: string; lagHours: number; direction: string;
    windowEnd: string; fingerprint: string; card: unknown;
  }>;
  confirmations: Array<{ pairKey: string; eventType: string; detail: unknown }>;
}

export interface DiscoveryRow {
  id: string;
  pair_key: string;
  series_a: string;
  series_b: string;
  lag_hours: number;
  direction: string;
  window_end: string;
  engine_version: string;
  run_id: string;
  fingerprint: string;
  card: unknown;
  detected_at: string;
  prev_chain_hash: string | null;
  chain_hash: string;
  /** Latest event type; a discovery's status is never an edited column. */
  status: string;
}

export interface DiscoveryEventRow {
  id: string;
  event_type: string;
  run_id: string;
  detail: unknown;
  created_at: string;
}

export interface DiscoveryRunRow {
  id: string;
  engine_version: string;
  epoch_end: string;
  fdr_level: number;
  method: string;
  series_count: number;
  hypotheses_considered: number;
  hypotheses_tested: number;
  rejections: number;
  completed_at: string;
}

/** One link of the chain, with detected_at exactly as the chain hash was computed from it. */
export interface DiscoveryChainRow {
  id: string;
  fingerprint: string;
  detected_at_text: string;
  prev_chain_hash: string | null;
  chain_hash: string;
}

export interface DiscoveryAnchorRow {
  id: string;
  discovery_id: string;
  chain_hash: string;
  calendar_url: string;
  receipt: Uint8Array;
  submitted_at: string;
}

export interface DiscoveryRepo {
  runExists(engineVersion: string, epochEnd: string): Promise<boolean>;
  /** Discoveries on record for an engine version, for confirmation testing. */
  listOpen(engineVersion: string): Promise<Array<{ pair_key: string; lag_hours: number; direction: string; window_end: string }>>;
  /**
   * Persists a whole run atomically. Returns null when another replica already
   * recorded this epoch, in which case nothing is written.
   */
  persistRun(run: DiscoveryRunWrite): Promise<{ runId: string; discoveryIds: string[] } | null>;
  list(limit: number): Promise<DiscoveryRow[]>;
  findById(id: string): Promise<DiscoveryRow | null>;
  eventsFor(discoveryId: string): Promise<DiscoveryEventRow[]>;
  runById(runId: string): Promise<DiscoveryRunRow | null>;
  latestRun(): Promise<DiscoveryRunRow | null>;
  /** Other discoveries that share a series with this one. */
  related(discoveryId: string, seriesA: string, seriesB: string, limit: number): Promise<DiscoveryRow[]>;
  /** The newest discovery: its chain hash commits to every one before it. */
  chainHead(): Promise<DiscoveryChainRow | null>;
  /** Links of the chain in order, for a third party to recompute. */
  chainSegment(fromId: string, limit: number): Promise<DiscoveryChainRow[]>;
  /** Calendars that already hold a receipt for this chain hash. */
  anchoredCalendars(chainHash: string): Promise<string[]>;
  /** Stores one calendar's receipt. False when that calendar's receipt is already held. */
  recordAnchor(anchor: { discoveryId: string; chainHash: string; calendarUrl: string; receipt: Uint8Array }): Promise<boolean>;
  listAnchors(limit: number): Promise<DiscoveryAnchorRow[]>;
  findAnchor(id: string): Promise<DiscoveryAnchorRow | null>;
  /**
   * The anchors that cover a discovery: those of the earliest anchored chain
   * head at or after it. Empty until a head that includes it is anchored.
   */
  anchorsCovering(discoveryId: string): Promise<DiscoveryAnchorRow[]>;
}

/**
 * Discovery Engine persistence, see docs/milestone-d14-rewind-discovery.md.
 * Every table is append-only in the database; detected_at and the hash chain
 * are written by a trigger, so this repository cannot choose either.
 */
export function createDiscoveryRepo(sql: Sql): DiscoveryRepo {
  const discoveryColumns = sql`
    d.id::text, d.pair_key, d.series_a, d.series_b, d.lag_hours, d.direction, d.window_end, d.engine_version,
    d.run_id::text, d.fingerprint, d.card, d.detected_at, d.prev_chain_hash, d.chain_hash,
    (select e.event_type from discovery_events e where e.discovery_id = d.id order by e.id desc limit 1) as status
  `;
  const chainColumns = sql`
    d.id::text, d.fingerprint, d.prev_chain_hash, d.chain_hash,
    to_char(d.detected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as detected_at_text
  `;
  const anchorColumns = sql`a.id::text, a.discovery_id::text, a.chain_hash, a.calendar_url, a.receipt, a.submitted_at`;
  const runColumns = sql`
    id::text, engine_version, epoch_end, fdr_level::float8 as fdr_level, method, series_count,
    hypotheses_considered, hypotheses_tested, rejections, completed_at
  `;

  return {
    async runExists(engineVersion, epochEnd) {
      const [row] = await sql<Array<{ id: string }>>`
        select id::text from discovery_runs where engine_version = ${engineVersion} and epoch_end = ${epochEnd}::timestamptz
      `;
      return Boolean(row);
    },

    async listOpen(engineVersion) {
      return sql<Array<{ pair_key: string; lag_hours: number; direction: string; window_end: string }>>`
        select pair_key, lag_hours, direction, window_end from discoveries where engine_version = ${engineVersion}
      `;
    },

    async persistRun(run) {
      return sql.begin(async (tx) => {
        const [runRow] = await tx<Array<{ id: string }>>`
          insert into discovery_runs (
            engine_version, epoch_end, window_hours, baseline_hours, fdr_level, method,
            series_count, hypotheses_considered, hypotheses_tested, rejections
          ) values (
            ${run.engineVersion}, ${run.epochEnd}, ${run.windowHours}, ${run.baselineHours}, ${run.fdrLevel}, ${run.method},
            ${run.seriesCount}, ${run.hypothesesConsidered}, ${run.hypothesesTested}, ${run.rejections}
          )
          on conflict (engine_version, epoch_end) do nothing
          returning id::text
        `;
        if (!runRow) return null;

        // One statement per chunk: a run over a few dozen series considers
        // tens of thousands of hypotheses, and every one of them is recorded.
        // Every array is sent as text and cast by PostgreSQL: the driver infers
        // an array type from its elements and has none for boolean.
        const numeric = (value: number | null) => (value === null ? null : String(value));
        for (let offset = 0; offset < run.tests.length; offset += 2000) {
          const chunk = run.tests.slice(offset, offset + 2000);
          await tx`
            insert into discovery_tests (
              run_id, pair_key, series_a, series_b, lag_hours, status, role,
              r, r_baseline, n, n_effective, p_value, q_value, rejected
            )
            select ${runRow.id}::bigint, * from unnest(
              ${chunk.map((t) => t.pairKey)}::text[], ${chunk.map((t) => t.seriesA)}::text[], ${chunk.map((t) => t.seriesB)}::text[],
              ${chunk.map((t) => String(t.lagHours))}::int[], ${chunk.map((t) => t.status)}::text[], ${chunk.map((t) => t.role)}::text[],
              ${chunk.map((t) => numeric(t.r))}::numeric[], ${chunk.map((t) => numeric(t.rBaseline))}::numeric[], ${chunk.map((t) => String(t.n))}::int[],
              ${chunk.map((t) => numeric(t.nEffective))}::numeric[], ${chunk.map((t) => numeric(t.pValue))}::numeric[],
              ${chunk.map((t) => numeric(t.qValue))}::numeric[], ${chunk.map((t) => String(t.rejected))}::boolean[]
            )
          `;
        }

        const discoveryIds: string[] = [];
        for (const d of run.discoveries) {
          const [row] = await tx<Array<{ id: string }>>`
            insert into discoveries (
              pair_key, series_a, series_b, lag_hours, direction, window_end, engine_version, run_id, fingerprint, card
            ) values (
              ${d.pairKey}, ${d.seriesA}, ${d.seriesB}, ${d.lagHours}, ${d.direction}, ${d.windowEnd},
              ${run.engineVersion}, ${runRow.id}, ${d.fingerprint}, ${tx.json(d.card as JsonValue)}
            )
            on conflict (pair_key, engine_version) do nothing
            returning id::text
          `;
          if (!row) continue;
          discoveryIds.push(row.id);
          await tx`
            insert into discovery_events (discovery_id, run_id, event_type, detail)
            values (${row.id}, ${runRow.id}, 'CANDIDATE', ${tx.json({ fingerprint: d.fingerprint } as JsonValue)})
          `;
        }

        for (const c of run.confirmations) {
          await tx`
            insert into discovery_events (discovery_id, run_id, event_type, detail)
            select d.id, ${runRow.id}, ${c.eventType}, ${tx.json(c.detail as JsonValue)}
            from discoveries d
            where d.pair_key = ${c.pairKey} and d.engine_version = ${run.engineVersion}
            on conflict (discovery_id, run_id) do nothing
          `;
        }
        return { runId: runRow.id, discoveryIds };
      });
    },

    async list(limit) {
      return sql<DiscoveryRow[]>`select ${discoveryColumns} from discoveries d order by d.id desc limit ${limit}`;
    },

    async findById(id) {
      const [row] = await sql<DiscoveryRow[]>`select ${discoveryColumns} from discoveries d where d.id = ${id}`;
      return row ?? null;
    },

    async eventsFor(discoveryId) {
      return sql<DiscoveryEventRow[]>`
        select id::text, event_type, run_id::text, detail, created_at
        from discovery_events where discovery_id = ${discoveryId} order by id asc
      `;
    },

    async runById(runId) {
      const [row] = await sql<DiscoveryRunRow[]>`select ${runColumns} from discovery_runs where id = ${runId}`;
      return row ?? null;
    },

    async latestRun() {
      const [row] = await sql<DiscoveryRunRow[]>`select ${runColumns} from discovery_runs order by epoch_end desc limit 1`;
      return row ?? null;
    },

    async related(discoveryId, seriesA, seriesB, limit) {
      return sql<DiscoveryRow[]>`
        select ${discoveryColumns} from discoveries d
        where d.id <> ${discoveryId}
          and (d.series_a in (${seriesA}, ${seriesB}) or d.series_b in (${seriesA}, ${seriesB}))
        order by d.id desc limit ${limit}
      `;
    },

    async chainHead() {
      const [row] = await sql<DiscoveryChainRow[]>`select ${chainColumns} from discoveries d order by d.id desc limit 1`;
      return row ?? null;
    },

    async chainSegment(fromId, limit) {
      return sql<DiscoveryChainRow[]>`select ${chainColumns} from discoveries d where d.id >= ${fromId} order by d.id asc limit ${limit}`;
    },

    async anchoredCalendars(chainHash) {
      const rows = await sql<Array<{ calendar_url: string }>>`select calendar_url from discovery_anchors where chain_hash = ${chainHash}`;
      return rows.map((r) => r.calendar_url);
    },

    async recordAnchor(anchor) {
      const rows = await sql<Array<{ id: string }>>`
        insert into discovery_anchors (discovery_id, chain_hash, calendar_url, receipt)
        values (${anchor.discoveryId}, ${anchor.chainHash}, ${anchor.calendarUrl}, ${Buffer.from(anchor.receipt)})
        on conflict (chain_hash, calendar_url) do nothing
        returning id::text
      `;
      return rows.length > 0;
    },

    async listAnchors(limit) {
      return sql<DiscoveryAnchorRow[]>`select ${anchorColumns} from discovery_anchors a order by a.id desc limit ${limit}`;
    },

    async findAnchor(id) {
      const [row] = await sql<DiscoveryAnchorRow[]>`select ${anchorColumns} from discovery_anchors a where a.id = ${id}`;
      return row ?? null;
    },

    async anchorsCovering(discoveryId) {
      return sql<DiscoveryAnchorRow[]>`
        select ${anchorColumns} from discovery_anchors a
        where a.discovery_id = (select min(discovery_id) from discovery_anchors where discovery_id >= ${discoveryId})
        order by a.id asc
      `;
    }
  };
}
