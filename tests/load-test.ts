/**
 * Analysis load test harness, see milestone D2 Phase 2-7.
 *
 * Submits N analysis jobs (optionally via the HTTP API) and measures
 * queue wait, worker processing duration, RPC stats, and completion rates.
 *
 * Usage:
 *   pnpm loadtest:analysis --concurrency=5 --count=10 --wallets=file.json
 *   pnpm loadtest:analysis --via-api --concurrency=10 --count=10
 *
 * Flags:
 *   --concurrency=N      number of simultaneous in-flight requests (default 5)
 *   --count=N            total number of analysis requests (default = concurrency)
 *   --wallets=path       JSON file with array of { category, address, note }
 *   --timeout=SECONDS    per-analysis timeout in seconds (default 600)
 *   --via-api            submit through the HTTP API (POST /v1/analyses)
 *   --api-url=URL        API base URL when --via-api (default http://localhost:3001)
 *   --same-wallet        use the same wallet for every request (dedup test)
 *   --cache-reuse        wait for the first analysis to finish, then re-request
 */

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "bullmq";
import { loadConfig } from "@aegix/config";
import { CANONICAL_PROGRAMS } from "@aegix/types";
import { createDb, createAnalysisJobRepo, createWalletRepo, type AnalysisJobRow } from "@aegix/database";
import { createCache } from "@aegix/cache";
import { createQueues } from "@aegix/queue";
import { createLogger } from "@aegix/logging";
import { processAnalysis } from "../apps/worker/src/processors/analysis.js";
import type { ProcessorContext } from "../apps/worker/src/worker.js";

interface LoadWallet {
  category: string;
  address: string;
  note: string;
}

interface Options {
  concurrency: number;
  count: number;
  walletsPath: string | null;
  timeoutSeconds: number;
  viaApi: boolean;
  apiUrl: string;
  sameWallet: boolean;
  cacheReuse: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    concurrency: 5,
    count: 0,
    walletsPath: null,
    timeoutSeconds: 600,
    viaApi: false,
    apiUrl: "http://localhost:3001",
    sameWallet: false,
    cacheReuse: false
  };
  for (const arg of argv) {
    const [key, value] = arg.split("=");
    switch (key) {
      case "--concurrency":
        opts.concurrency = Number(value);
        break;
      case "--count":
        opts.count = Number(value);
        break;
      case "--wallets":
        opts.walletsPath = value;
        break;
      case "--timeout":
        opts.timeoutSeconds = Number(value);
        break;
      case "--via-api":
        opts.viaApi = true;
        break;
      case "--api-url":
        opts.apiUrl = value;
        break;
      case "--same-wallet":
        opts.sameWallet = true;
        break;
      case "--cache-reuse":
        opts.cacheReuse = true;
        break;
    }
  }
  if (opts.count <= 0) opts.count = opts.concurrency;
  return opts;
}


/**
 * Resolves a fixture program address from the canonical catalog instead of
 * copying it. These fixtures used to carry their own copies, and four of them
 * silently rotted into addresses with no mainnet account — the fixture still
 * passed while describing a protocol it no longer pointed at. A stale label
 * now throws instead of quietly testing the wrong address.
 */
function catalogProgram(label: string): string {
  const program = CANONICAL_PROGRAMS.find((p) => p.label === label);
  if (!program) throw new Error(`fixture references "${label}", which is not in the canonical program catalog`);
  return program.programId;
}

const DEFAULT_WALLETS: LoadWallet[] = [
  { category: "TOKEN_MINT", address: "So11111111111111111111111111111111111111112", note: "Wrapped SOL mint" },
  { category: "SYSTEM_ACCOUNT", address: "SysvarC1ock11111111111111111111111111111111", note: "clock sysvar" },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("Jupiter Aggregator v6"), note: "Jupiter v6" },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("Raydium Liquidity Pool v4"), note: "Raydium AMM" },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("Raydium Concentrated Liquidity"), note: "Raydium CLMM" },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("Pump.fun Bonding Curve"), note: "Pump.fun" },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("Kamino Lending"), note: "Kamino" },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("Drift v2"), note: "Drift" },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("OpenBook v1"), note: "OpenBook" },
  { category: "NEW_WALLET", address: "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a", note: "fresh, zero activity" }
];

function loadWallets(path: string | null, opts: Options): LoadWallet[] {
  if (path) {
    const data = JSON.parse(readFileSync(path, "utf8")) as LoadWallet[];
    if (opts.sameWallet && data.length > 0) return [data[0]!];
    return data;
  }
  if (opts.sameWallet) return [DEFAULT_WALLETS[0]!];
  return DEFAULT_WALLETS;
}

interface JobTiming {
  index: number;
  category: string;
  address: string;
  analysisId: string | null;
  requestAcceptedMs: number;
  queueWaitMs: number;
  workerDurationMs: number;
  totalMs: number;
  status: string;
  failureCode: string | null;
  transactionsParsed: number;
  rpcFailures: number;
  parserSuccessRate: number | null;
  rpc: Record<string, unknown> | null;
  error?: string;
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config, { service: "loadtest" });
  const sql = createDb(config.DATABASE_URL);
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  const queues = createQueues(config);

  const wallets = loadWallets(opts.walletsPath, opts);
  console.log(`loadtest: ${opts.count} requests, concurrency ${opts.concurrency}, via-api=${opts.viaApi}, same-wallet=${opts.sameWallet}, cache-reuse=${opts.cacheReuse}`);

  const timings: JobTiming[] = [];
  let next = 0;
  let completed = 0;
  const startedAll = Date.now();

  async function submitOne(index: number): Promise<void> {
    const wallet = wallets[index % wallets.length]!;
    const t0 = Date.now();
    let analysisId: string | null = null;
    try {
      if (opts.viaApi) {
        const res = await fetch(`${opts.apiUrl}/v1/analyses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: wallet.address })
        });
        const body = (await res.json()) as { analysisId?: string; status?: string; code?: string; message?: string };
        if (!res.ok || !body.analysisId) {
          timings.push({
            index,
            category: wallet.category,
            address: wallet.address,
            analysisId: null,
            requestAcceptedMs: Date.now() - t0,
            queueWaitMs: 0,
            workerDurationMs: 0,
            totalMs: Date.now() - t0,
            status: `API_ERROR:${res.status}`,
            failureCode: body.code ?? null,
            transactionsParsed: 0,
            rpcFailures: 0,
            parserSuccessRate: null,
            rpc: null,
            error: body.message
          });
          return;
        }
        analysisId = body.analysisId;
      } else {
        const w = await walletRepo.findOrCreate("solana", wallet.address);
        const job = await jobRepo.create({
          walletId: w.id,
          requestedBy: null,
          analysisType: "full",
          priority: "standard"
        });
        analysisId = job.id;
        await queues.analysisStandard.add(
          "analyze",
          { analysisId: job.id, walletAddress: wallet.address, chain: "solana", analysisType: "full" },
          { jobId: `loadtest-${job.id}`, attempts: 3, backoff: { type: "exponential", delay: 2000 } }
        );
      }

      const acceptedMs = Date.now() - t0;
      const job = await pollJob(jobRepo, analysisId, opts.timeoutSeconds * 1000);
      const totalMs = Date.now() - t0;
      const dq = (job?.data_quality ?? {}) as Record<string, unknown>;
      const queueWaitMs = job?.started_at
        ? new Date(job.started_at).getTime() - new Date(job.requested_at).getTime()
        : 0;
      const workerDurationMs = job?.started_at && job?.completed_at
        ? new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()
        : 0;
      timings.push({
        index,
        category: wallet.category,
        address: wallet.address,
        analysisId: job?.id ?? analysisId,
        requestAcceptedMs: acceptedMs,
        queueWaitMs,
        workerDurationMs,
        totalMs,
        status: job?.status ?? "UNKNOWN",
        failureCode: job?.failure_code ?? null,
        transactionsParsed: (dq.transactionsParsed as number) ?? 0,
        rpcFailures: (dq.rpcFailures as number) ?? 0,
        parserSuccessRate: (dq.parserSuccessRate as number) ?? null,
        rpc: (dq.rpc as Record<string, unknown>) ?? null
      });
    } catch (err) {
      timings.push({
        index,
        category: wallet.category,
        address: wallet.address,
        analysisId,
        requestAcceptedMs: Date.now() - t0,
        queueWaitMs: 0,
        workerDurationMs: 0,
        totalMs: Date.now() - t0,
        status: "ERROR",
        failureCode: null,
        transactionsParsed: 0,
        rpcFailures: 0,
        parserSuccessRate: null,
        rpc: null,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err)
      });
    } finally {
      completed += 1;
    }
  }

  async function worker(): Promise<void> {
    while (next < opts.count) {
      const i = next++;
      await submitOne(i);
    }
  }

  // Optionally consume jobs inline (bypass external worker process) for
  // deterministic end-to-end timing: LOADTEST_INLINE=1 runs processAnalysis
  // here instead of relying on a separate worker process.
  if (process.env.LOADTEST_INLINE === "1" && !opts.viaApi) {
    const ctx = { config, sql, logger };
    void runInlineConsumer(ctx, queues);
  }

  const workerPool = Array.from({ length: Math.min(opts.concurrency, opts.count) }, () => worker());
  await Promise.all(workerPool);

  // Give the inline consumer a moment to drain remaining queued jobs.
  if (process.env.LOADTEST_INLINE === "1" && !opts.viaApi) {
    await sleep(5000);
  }

  const totalMs = Date.now() - startedAll;
  const ok = timings.filter((t) => t.status === "READY");
  const failed = timings.filter((t) => t.status !== "READY" && t.status !== "ERROR");
  const errored = timings.filter((t) => t.status === "ERROR");
  const avgQueueWait = timings.reduce((s, t) => s + t.queueWaitMs, 0) / Math.max(1, timings.length);
  const avgWorker = timings.reduce((s, t) => s + t.workerDurationMs, 0) / Math.max(1, timings.length);
  const avgTotal = timings.reduce((s, t) => s + t.totalMs, 0) / Math.max(1, timings.length);

  console.log("\n=== LOAD TEST SUMMARY ===");
  console.table(timings.map((t) => ({
    index: t.index,
    status: t.status,
    category: t.category,
    totalSec: Math.round(t.totalMs / 100) / 10,
    queueWaitSec: Math.round(t.queueWaitMs / 100) / 10,
    workerSec: Math.round(t.workerDurationMs / 100) / 10,
    parsed: t.transactionsParsed,
    rpcFail: t.rpcFailures,
    parserRate: t.parserSuccessRate ?? "—"
  })));
  console.log(`total wall: ${Math.round(totalMs / 100) / 10}s`);
  console.log(`ready: ${ok.length}, failed: ${failed.length}, errored: ${errored.length}`);
  console.log(`avg queue wait: ${Math.round(avgQueueWait / 100) / 10}s, avg worker: ${Math.round(avgWorker / 100) / 10}s, avg total: ${Math.round(avgTotal / 100) / 10}s`);
  const allRpc = timings.flatMap((t) => (t.rpc ? [t.rpc] : []));
  if (allRpc.length > 0) {
    console.log("rpc provider stats:", JSON.stringify(allRpc[0], null, 2));
  }

  await cache.close();
  await queues.close();
  await sql.end();
  process.exit(ok.length === opts.count ? 0 : 1);
}

async function pollJob(
  jobRepo: ReturnType<typeof createAnalysisJobRepo>,
  analysisId: string,
  timeoutMs: number
): Promise<AnalysisJobRow | null> {
  const deadline = Date.now() + timeoutMs;
  let last: AnalysisJobRow | null = null;
  while (Date.now() < deadline) {
    last = await jobRepo.findById(analysisId);
    if (!last) return null;
    if (last.status === "READY" || last.status === "FAILED") return last;
    await sleep(2000);
  }
  return last;
}

/** Consumes analysis.standard jobs inline so the harness is self-contained. */
function runInlineConsumer(ctx: ProcessorContext, queue: ReturnType<typeof createQueues>): Promise<void> {
  return new Promise((resolve) => {
    const worker = new Worker(
      "analysis.standard",
      async (job) => {
        await processAnalysis(job as never, ctx);
      },
      {
        connection: { url: ctx.config.REDIS_URL, db: ctx.config.REDIS_QUEUE_DB },
        prefix: ctx.config.QUEUE_PREFIX,
        concurrency: Math.max(1, ctx.config.ANALYSIS_WORKER_CONCURRENCY)
      }
    );
    worker.on("completed", maybeFinish);
    worker.on("failed", maybeFinish);
    function maybeFinish() {
      // resolve when the queue is idle: no active/waiting jobs remain
      void queue.analysisStandard.getJobCounts().then((counts) => {
        if (counts.active === 0 && counts.waiting === 0 && counts.delayed === 0) {
          void worker.close().then(resolve);
        }
      });
    }
  });
}

run().catch((err) => {
  console.error("loadtest failed:", err);
  process.exitCode = 1;
});
