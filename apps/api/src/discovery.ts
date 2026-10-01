import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import { createDiscoveryRepo, type DiscoveryRow, type DiscoveryRunRow, type Sql } from "@aegix/database";

export interface DiscoveryDeps {
  app: FastifyInstance;
  config: AppConfig;
  sql: Sql;
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<{ id: string; isAnonymous: boolean } | null>;
}

/** Public Discovery ID. The number is the row id; the chain hash is the proof. */
export function discoveryDisplayId(id: string): string {
  return `AEX-${id}`;
}

function parseDiscoveryId(value: string): string | null {
  const match = /^(?:AEX-)?(\d{1,18})$/i.exec(value);
  return match ? match[1]! : null;
}

function view(row: DiscoveryRow) {
  return {
    id: discoveryDisplayId(row.id),
    status: row.status,
    firstDetectedAt: new Date(row.detected_at).toISOString(),
    seriesA: row.series_a,
    seriesB: row.series_b,
    lagHours: row.lag_hours,
    direction: row.direction,
    engineVersion: row.engine_version,
    fingerprint: row.fingerprint,
    prevChainHash: row.prev_chain_hash,
    chainHash: row.chain_hash,
    card: row.card
  };
}

function runView(run: DiscoveryRunRow | null) {
  return run ? {
    epochEnd: new Date(run.epoch_end).toISOString(),
    completedAt: new Date(run.completed_at).toISOString(),
    engineVersion: run.engine_version,
    method: run.method,
    fdrLevel: Number(run.fdr_level),
    seriesCount: run.series_count,
    hypothesesConsidered: run.hypotheses_considered,
    hypothesesTested: run.hypotheses_tested,
    rejections: run.rejections
  } : null;
}

/**
 * AEGIX Discovery Engine read API (D14), see docs/milestone-d14-rewind-discovery.md.
 * Read-only: discoveries are written by the worker's scan and by nothing else.
 */
export function registerDiscovery(deps: DiscoveryDeps): void {
  const { app, config, sql } = deps;
  const repo = createDiscoveryRepo(sql);
  const rate = { rateLimit: { max: config.REWIND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } };

  async function admit(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (!config.ENABLE_DISCOVERY) { reply.code(403).send({ code: "FEATURE_DISABLED" }); return false; }
    const user = await deps.requireUser(req, reply);
    if (!user) return false;
    if (user.isAnonymous) { reply.code(401).send({ code: "UNAUTHENTICATED" }); return false; }
    return true;
  }

  app.get<{ Querystring: { limit?: string } }>("/v1/discoveries", { config: rate }, async (req, reply) => {
    if (!(await admit(req, reply))) return;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const [rows, latestRun] = await Promise.all([repo.list(limit), repo.latestRun()]);
    // The latest run is returned even when it found nothing: an empty list
    // with no run means the engine has not scanned, which is a different fact.
    return { discoveries: rows.map(view), latestRun: runView(latestRun) };
  });

  app.get<{ Params: { id: string } }>("/v1/discoveries/:id", { config: rate }, async (req, reply) => {
    if (!(await admit(req, reply))) return;
    const id = parseDiscoveryId(req.params.id);
    if (!id) return reply.code(400).send({ code: "INVALID_DISCOVERY_ID" });
    const row = await repo.findById(id);
    if (!row) return reply.code(404).send({ code: "DISCOVERY_NOT_FOUND" });
    const [events, run, related] = await Promise.all([
      repo.eventsFor(row.id), repo.runById(row.run_id), repo.related(row.id, row.series_a, row.series_b, 10)
    ]);
    return {
      discovery: view(row),
      run: runView(run),
      events: events.map((e) => ({ type: e.event_type, at: new Date(e.created_at).toISOString(), detail: e.detail })),
      related: related.map((r) => ({ id: discoveryDisplayId(r.id), status: r.status, seriesA: r.series_a, seriesB: r.series_b,
        lagHours: r.lag_hours, direction: r.direction, firstDetectedAt: new Date(r.detected_at).toISOString() }))
    };
  });
}
