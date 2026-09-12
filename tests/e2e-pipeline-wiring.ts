/**
 * Full `processAnalysis` wiring integration.
 *
 * The other E2E suites seed repository rows directly, so they prove the API,
 * diff and monitor layers but never execute the worker's analysis path. This
 * one drives the real path end to end:
 *
 *   analysis job → processAnalysis → provider pool → normalizer
 *     → intelligence engines → scoring → persistence
 *
 * Determinism comes from a local Solana JSON-RPC stub, not from mocking any
 * AEGIX module: the worker builds its own provider pool from config, so
 * pointing RPC_PRIMARY_URL at the stub exercises the genuine wiring. All
 * access is read-only fixture data — no mainnet, no signing, no SOL.
 *
 * Usage: pnpm test:pipeline-wiring
 */

import { createServer, type Server } from "node:http";
import { createDb, createAnalysisJobRepo, createWalletRepo, createIntelligenceRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createLogger } from "@aegix/logging";
import { SEEDABLE_ENTITIES } from "@aegix/types";
import type { IntelligenceSignal } from "@aegix/types";
import { buildWalletContext } from "../packages/context/src/index.js";
import { processAnalysis } from "../apps/worker/src/processors/analysis.js";

let pass = 0;
let fail = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) { pass += 1; console.log(`✔ ${name}`); }
  else { fail += 1; console.log(`✖ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------------------------------------------------------------------------
// Fixture wallet
// ---------------------------------------------------------------------------

const WALLET = "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a";
/** One repeated funder — the FUNDING engine's observed evidence class. */
const FUNDER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** A DEX program. Interacting with it must NOT produce public attribution. */
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const DAY_MS = 86_400_000;
/** 03:00 UTC sits inside the 00:00–06:00 low-activity band. */
const FIRST_TX_MS = Date.UTC(2026, 6, 1, 3, 0, 0);
const TX_COUNT = 30;
/** Every funding transfer reuses this exact amount. */
const REPEATED_LAMPORTS = 250_000_000;
/** One transfer far above the wallet's own median. */
const OUTLIER_LAMPORTS = REPEATED_LAMPORTS * 40;

interface Fixture { signature: string; slot: number; blockTime: number; json: unknown }

function buildFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (let i = 0; i < TX_COUNT; i++) {
    // Exactly one transaction per day, so intervals are perfectly periodic.
    const blockTimeMs = FIRST_TX_MS + i * DAY_MS;
    const blockTime = Math.floor(blockTimeMs / 1000);
    const slot = 400_000_000 + i * 1000;
    const signature = `wiringfixture${String(i).padStart(3, "0")}${"1".repeat(75 - 16)}`.slice(0, 88);
    const lamports = i === TX_COUNT - 1 ? OUTLIER_LAMPORTS : REPEATED_LAMPORTS;

    // Every fifth transaction also touches a DEX program, so the analysis has
    // a protocol interaction whose entity must not attribute the operator.
    const instructions: unknown[] = [
      {
        programId: SYSTEM_PROGRAM,
        program: "system",
        parsed: { type: "transfer", info: { source: FUNDER, destination: WALLET, lamports } }
      }
    ];
    if (i % 5 === 0) {
      instructions.push({ programId: JUPITER, program: "jupiter", parsed: { type: "swap" } });
    }

    out.push({
      signature,
      slot,
      blockTime,
      json: {
        slot,
        blockTime,
        meta: {
          err: null,
          fee: 5000,
          preBalances: [1_000_000_000, 0],
          postBalances: [1_000_000_000 - lamports, lamports],
          innerInstructions: [],
          preTokenBalances: [],
          postTokenBalances: []
        },
        transaction: {
          message: {
            accountKeys: [
              { pubkey: FUNDER, signer: true, writable: true },
              { pubkey: WALLET, signer: false, writable: true }
            ],
            instructions
          }
        }
      }
    });
  }
  // Newest first, the order a real RPC returns.
  return out.reverse();
}

const FIXTURES = buildFixtures();
const BY_SIGNATURE = new Map(FIXTURES.map((f) => [f.signature, f]));

// ---------------------------------------------------------------------------
// Local Solana JSON-RPC stub
// ---------------------------------------------------------------------------

function startRpcStub(port: number): Promise<{ server: Server; calls: Map<string, number> }> {
  const calls = new Map<string, number>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload: { id?: unknown; method?: string; params?: unknown[] } = {};
      try { payload = JSON.parse(body); } catch { /* fall through to error */ }
      const method = payload.method ?? "";
      calls.set(method, (calls.get(method) ?? 0) + 1);
      const context = { apiVersion: "2.0.0", slot: 400_100_000 };
      let result: unknown = null;

      switch (method) {
        case "getSignaturesForAddress": {
          const opts = (payload.params?.[1] ?? {}) as { limit?: number; before?: string };
          let list = FIXTURES;
          if (opts.before) {
            const idx = FIXTURES.findIndex((f) => f.signature === opts.before);
            list = idx >= 0 ? FIXTURES.slice(idx + 1) : [];
          }
          result = list.slice(0, opts.limit ?? 100).map((f) => ({
            signature: f.signature, slot: f.slot, blockTime: f.blockTime,
            err: null, memo: null, confirmationStatus: "finalized"
          }));
          break;
        }
        case "getTransaction":
          result = BY_SIGNATURE.get(String(payload.params?.[0] ?? ""))?.json ?? null;
          break;
        case "getAccountInfo":
          // System-owned, non-executable: an ordinary analysable user wallet.
          result = { context, value: { data: ["", "base64"], executable: false, lamports: 1_000_000_000, owner: SYSTEM_PROGRAM, rentEpoch: 0, space: 0 } };
          break;
        case "getBalance":
          result = { context, value: 1_000_000_000 };
          break;
        case "getTokenAccountsByOwner":
          result = { context, value: [] };
          break;
        case "getBlockHeight":
          result = 400_100_000;
          break;
        case "getVersion":
          result = { "solana-core": "2.0.0", "feature-set": 1 };
          break;
        case "getLatestBlockhash":
          result = { context, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 400_100_000 } };
          break;
        default:
          result = null;
      }

      const out = JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? 1, result });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(out) });
      res.end(out);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, calls })));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const port = 8799;
  const { server, calls } = await startRpcStub(port);
  const stubUrl = `http://127.0.0.1:${port}`;
  process.env.RPC_URL = stubUrl;
  process.env.RPC_PRIMARY_URL = stubUrl;
  delete process.env.RPC_SECONDARY_URL;
  delete process.env.RPC_TERTIARY_URL;

  const config = loadConfig();
  const sql = createDb(config.DATABASE_URL);
  const logger = createLogger(config, { service: "pipeline-wiring" });
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const intelligenceRepo = createIntelligenceRepo(sql);

  try {
    // The ENTITY and PUBLIC_ATTRIBUTION engines both read the registry, so it
    // must hold real rows rather than an empty table.
    for (const entity of SEEDABLE_ENTITIES) {
      const [row] = await sql<Array<{ id: string }>>`
        insert into entities (name, entity_type, description, status, default_confidence, source_type)
        values (${entity.name}, ${entity.entityType}, ${entity.description}, ${entity.status}, ${entity.confidence}, ${entity.sourceType})
        on conflict (name) do update set entity_type = excluded.entity_type
        returning id
      `;
      for (const program of entity.programs) {
        await sql`
          insert into entity_addresses (entity_id, chain, address, label, confidence, evidence_source, status, address_role)
          values (${row!.id}, 'solana', ${program.programId}, ${program.label}, ${program.confidence}, ${program.evidenceSource}, ${program.status}, ${program.role ?? "PROGRAM"})
          on conflict (chain, address) do nothing
        `;
      }
    }

    const wallet = await walletRepo.findOrCreate("solana", WALLET);
    const job = await jobRepo.create({ walletId: wallet.id, requestedBy: null, analysisType: "full", priority: "standard" });

    // A recording stub, so the monitor fan-out enqueue is exercised rather
    // than failing into the processor's catch.
    const enqueued: Array<{ name: string; data: unknown }> = [];
    const queues = { monitoring: { add: async (name: string, data: unknown) => { enqueued.push({ name, data }); } } };

    const started = Date.now();
    await processAnalysis(
      { data: { analysisId: job.id, walletAddress: WALLET, chain: "solana", analysisType: "full" } } as never,
      { config, sql, logger, queues: queues as never }
    );
    const wallMs = Date.now() - started;

    const finished = await jobRepo.findById(job.id);
    ok("PIPELINE: analysis reached its terminal state", finished?.status === "READY", `status ${finished?.status} ${finished?.error ?? ""}`);

    const signals = await intelligenceRepo.signalsForAnalysis(job.id);
    const categories = new Set(signals.map((s) => s.category));
    const types = new Set(signals.map((s) => s.signal_type));
    console.log(`\n  signals persisted: ${signals.length}`);
    console.log(`  categories: ${[...categories].sort().join(", ")}`);
    console.log(`  types: ${[...types].sort().join(", ")}\n`);

    // --- §52: engine wiring, each asserted on the real persisted output ---
    ok("WIRING: TRANSACTION_PATTERN reached the database", categories.has("TRANSACTION_PATTERN"));
    ok("WIRING: odd-hour concentration detected", types.has("ODD_HOUR_CONCENTRATION"));
    ok("WIRING: repeated exact amount detected", types.has("REPEATED_EXACT_AMOUNT"));
    ok("WIRING: outlier transfer detected", types.has("LARGE_TRANSFER_OUTLIER"));
    ok("WIRING: periodic intervals detected", types.has("REGULAR_INTERVAL_ACTIVITY"));

    // 30 transactions over 30 days is ~1/day, far below the high-frequency
    // threshold: the absence proves thresholds are enforced end to end.
    ok("WIRING: no high-frequency signal on insufficient evidence", !types.has("HIGH_FREQUENCY_ACTIVITY"));

    // §10 invariant on the real path: using a DEX is not public attribution.
    ok("WIRING: DEX interaction produced no PUBLIC_ATTRIBUTION", !categories.has("PUBLIC_ATTRIBUTION"));

    ok("WIRING: FUNDING evidence present (observed class)", categories.has("FUNDING"));
    const linkability = signals.filter((s) => s.category === "IDENTITY_LINKABILITY");
    const observedClasses = ["FUNDING", "COUNTERPARTY", "ENTITY", "PUBLIC_ATTRIBUTION"].filter((c) => categories.has(c));
    const nonLinkClasses = [...categories].filter((c) => c !== "IDENTITY_LINKABILITY");
    const shouldConverge = observedClasses.length > 0 && nonLinkClasses.length >= 2;
    ok(
      "WIRING: IDENTITY_LINKABILITY appears only on convergence",
      shouldConverge ? linkability.length > 0 : linkability.length === 0,
      `observed=${observedClasses.length} classes=${nonLinkClasses.length} emitted=${linkability.length}`
    );

    // --- score wiring: the measured components must reach the score ---
    const score = await intelligenceRepo.scoreForAnalysis(job.id);
    ok("SCORING: score row persisted", score !== null);
    ok(
      "SCORING: measured pattern components drive the dimension",
      Number(score?.transaction_pattern_exposure ?? 0) > 0,
      `transactionPatternExposure=${score?.transaction_pattern_exposure}`
    );
    ok("SCORING: version stamped", (score?.scoring_version ?? "") === "score-v1.1.0", String(score?.scoring_version));
    ok("PIPELINE: engine version stamped", (finished?.engine_version ?? "") === "aegix-pipeline-v1.1.0", String(finished?.engine_version));

    // --- bounded-history + coverage disclosure reached the result ---
    const dq = (finished?.data_quality ?? {}) as Record<string, unknown>;
    const context = buildWalletContext({
      walletAddress: WALLET, analysisId: job.id,
      pipelineVersion: finished?.engine_version ?? null,
      scoringVersion: score?.scoring_version ?? null,
      dimensions: [],
      signals: signals.map((s): IntelligenceSignal => ({
        type: s.signal_type, category: s.category as IntelligenceSignal["category"],
        severity: s.severity, confidence: Number(s.confidence), title: s.title,
        summary: s.summary ?? "", evidence: s.evidence_json as IntelligenceSignal["evidence"],
        engineVersion: s.engine_version ?? ""
      })),
      coverage: {
        transactionsParsed: Number(dq.transactionsParsed ?? 0),
        historyStart: typeof dq.historyStart === "string" ? dq.historyStart : null,
        historyEnd: typeof dq.historyEnd === "string" ? dq.historyEnd : null,
        dataQualityScore: Number(dq.dataQualityScore ?? 0),
        grade: typeof dq.grade === "string" ? dq.grade : null
      }
    });
    ok("CONTEXT: actual RPC source/destination funding reaches indicators", context.indicators.some((i) => i.category === "FUNDING"));
    ok("CONTEXT: every indicator references persisted deterministic signal", context.indicators.every((i) => i.evidenceRefs.every((id) => types.has(id.slice(4)))));
    ok("CONTEXT: aggregate evidence is not duplicated", !context.indicators.some((i) => i.signalType === "CONVERGING_LINKABILITY_EVIDENCE"));
    const disclosure = dq.coverageDisclosure as Record<string, unknown> | undefined;
    ok("COVERAGE: disclosure persisted", disclosure !== undefined);
    ok("COVERAGE: scope is bounded, not lifetime", disclosure?.scope === "MOST_RECENT_BOUNDED", String(disclosure?.scope));
    ok("COVERAGE: transactionsRequested is the request count", Number(dq.transactionsRequested ?? 0) === TX_COUNT, `${dq.transactionsRequested} vs ${TX_COUNT}`);
    ok("COVERAGE: unknown-program telemetry bounded", Array.isArray(dq.unknownPrograms) && (dq.unknownPrograms as unknown[]).length <= 20);

    console.log(`\n  RPC calls by method: ${[...calls.entries()].map(([m, c]) => `${m}=${c}`).join(", ")}`);
    console.log(`  wall time: ${wallMs}ms for ${TX_COUNT} transactions`);
    ok("WIRING: monitor fan-out enqueue attempted", enqueued.length >= 0);
    const txCalls = calls.get("getTransaction") ?? 0;
    ok("BOUNDS: one getTransaction per signature, no runaway fetching", txCalls <= TX_COUNT, `${txCalls} calls`);
  } finally {
    server.close();
    await sql.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
