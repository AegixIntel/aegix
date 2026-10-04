import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import { createDiscoveryRepo, type DiscoveryAnchorRow, type DiscoveryRow, type DiscoveryRunRow, type Sql } from "@aegix/database";
import { OTS_CONTENT_TYPE, otsFile } from "@aegix/discovery";

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

/** One calendar's receipt for a chain head. The proof itself is the .ots file. */
function anchorView(row: DiscoveryAnchorRow) {
  return {
    id: row.id,
    covers: discoveryDisplayId(row.discovery_id),
    chainHash: row.chain_hash,
    calendar: row.calendar_url,
    submittedAt: new Date(row.submitted_at).toISOString(),
    proofPath: `/v1/discovery-chain/anchors/${row.id}.ots`
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
    const [events, run, related, anchors] = await Promise.all([
      repo.eventsFor(row.id), repo.runById(row.run_id), repo.related(row.id, row.series_a, row.series_b, 10), repo.anchorsCovering(row.id)
    ]);
    return {
      discovery: view(row),
      run: runView(run),
      // Empty until a chain head at or after this discovery has been anchored.
      anchors: anchors.map(anchorView),
      events: events.map((e) => ({ type: e.event_type, at: new Date(e.created_at).toISOString(), detail: e.detail })),
      related: related.map((r) => ({ id: discoveryDisplayId(r.id), status: r.status, seriesA: r.series_a, seriesB: r.series_b,
        lagHours: r.lag_hours, direction: r.direction, firstDetectedAt: new Date(r.detected_at).toISOString() }))
    };
  });

  // The chain and its anchors are public: they are what a third party needs
  // to check a detection time without an AEGIX account. They carry hashes and
  // timestamps only, never which series a discovery relates.
  function open(reply: FastifyReply): boolean {
    if (config.ENABLE_DISCOVERY) return true;
    reply.code(403).send({ code: "FEATURE_DISABLED" });
    return false;
  }

  app.get<{ Querystring: { from?: string; limit?: string } }>("/v1/discovery-chain", { config: rate }, async (req, reply) => {
    if (!open(reply)) return;
    const from = parseDiscoveryId(req.query.from ?? "1");
    if (!from) return reply.code(400).send({ code: "INVALID_DISCOVERY_ID" });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const [links, head] = await Promise.all([repo.chainSegment(from, limit), repo.chainHead()]);
    return {
      rule: "chainHash = sha256(prevChainHash + '|' + fingerprint + '|' + detectedAt), UTF-8, prevChainHash empty for the first link",
      head: head ? { id: discoveryDisplayId(head.id), chainHash: head.chain_hash } : null,
      links: links.map((l) => ({ id: discoveryDisplayId(l.id), fingerprint: l.fingerprint, detectedAt: l.detected_at_text, prevChainHash: l.prev_chain_hash, chainHash: l.chain_hash }))
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/discovery-chain/anchors", { config: rate }, async (req, reply) => {
    if (!open(reply)) return;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    return { anchors: (await repo.listAnchors(limit)).map(anchorView) };
  });

  app.get<{ Params: { file: string } }>("/v1/discovery-chain/anchors/:file", { config: rate }, async (req, reply) => {
    if (!open(reply)) return;
    const id = /^(\d{1,18})\.ots$/.exec(req.params.file)?.[1];
    if (!id) return reply.code(400).send({ code: "INVALID_ANCHOR_ID" });
    const anchor = await repo.findAnchor(id);
    if (!anchor) return reply.code(404).send({ code: "ANCHOR_NOT_FOUND" });
    return reply
      .header("content-type", OTS_CONTENT_TYPE)
      .header("content-disposition", `attachment; filename="aegix-${discoveryDisplayId(anchor.discovery_id)}-${anchor.id}.ots"`)
      .send(Buffer.from(otsFile(anchor.chain_hash, anchor.receipt)));
  });
}
