/**
 * D7 public multi-user load / admission validation harness (docs/milestone-d7.md
 * D7-S §105-§106 and D7-N §72-§73), see tests/e2e-d7.ts and the sibling
 * harnesses tests/load-test.ts, tests/load-test-correlation.ts,
 * tests/load-test-monitors.ts for the established conventions.
 *
 * Validates the D7 public load + multi-user concurrency & dedup guarantees
 * with BOUNDED, realistic sizes suitable for a small VPS / net-zero RPC
 * budget. It is OFFLINE by construction: no live mainnet RPC. Analyzed
 * wallets are seeded directly into local Postgres (wallets, analysis_jobs,
 * transactions, transfers, behavioral_features, exposure_scores) so the
 * in-process comparison / analysis admission services run entirely from
 * persisted data, exactly like load-test-correlation.ts and e2e-d7.ts.
 *
 * Scenarios:
 *   1. Multi-user setup    --users distinct wallet-auth users (D7-N §72)
 *   2. Same-wallet storm   --same-wallet concurrent analysis admission on ONE
 *                           wallet -> assert cache/dedup reuse (D7-N §72):
 *                           distinct jobs small, cache/dedup hits high.
 *      (a) warm: wallet already analyzed (fresh READY) -> every request is a
 *                cache hit, 0 new jobs.
 *      (b) cold: a fresh, never-analyzed eligible address -> exactly ONE job
 *                is created (distributed-lock dedup); the rest are reused.
 *   3. Same-pair storm     --same-pair concurrent (A,B) plus (B,A) ->
 *                           assert canonicalComparePair(a,b)===...b,a and that
 *                           A/B + B/A resolve to ONE cached/computed result
 *                           (D7-N §73).
 *   4. Different-wallet    --wallets distinct-wallet admission requests each
 *                           on a seeded analyzed wallet -> throughput p50/p95
 *                           with zero RPC (cache-only reuse).
 *   5. Cross-user isolation --users -> a saved comparison for user A is
 *                           invisible to user B; monitors do not cross lists
 *                           (E2E flow 9, repo-level).
 *
 * Default budget (all bounded; ~120 HTTP-equivalent requests, 20 users):
 *   --concurrency=5   worker pool (matches load-test.ts / -correlation.ts)
 *   --wallets=20      distinct seeded analyzed wallets
 *   --same-wallet=50  concurrent same-wallet admission requests
 *   --same-pair=25    A/B compares (+ 25 B/A = 50 total)
 *   --users=20        distinct authenticated users
 *   --timeout=120     per-request timeout (seconds)
 *
 * Rationale for the size (rooted in the measured/documented defaults):
 *   - Config budgets (packages/config): ANALYSIS_WORKER_CONCURRENCY=3,
 *     MAX_QUEUE_DEPTH=50, MAX_ACTIVE_GLOBAL=30, ANALYSIS_CACHE_TTL_SECONDS=3600,
 *     CORRELATION_CACHE_TTL_SECONDS=3600. A concurrency of 5 and ~120 requests
 *     stays far under those admission caps and under the global 120/min rate
 *     limit, so no SERVICE_BUSY / quota responses are triggered.
 *   - RPC budget: the harness is offline (no RPC provider is constructed), so
 *     RPC calls are 0. The only cost is local Postgres + Redis queries.
 *   - It deliberately does NOT hammer mainnet: every "analysis" is served from
 *     a pre-seeded analyzed wallet (cache/dedup) or creates exactly one job.
 *
 * Requires local Postgres + Redis (docker compose) on localhost:5432/6379.
 * Uses a DEDICATED database `aegix_loadtest` so it never clobbers the shared
 * `aegix` or `aegix_test` databases used by test:e2e-d7 and the other suites.
 * The database must exist once (create it with e.g.
 *   `docker exec aegix-postgres psql -U postgres -c "CREATE DATABASE aegix_loadtest"`
 * — but a stale/missing schema is fine: at the start of each run the harness
 * drops + re-migrates only that database). Run: pnpm loadtest:public
 */

// ---- Environment setup (must be set BEFORE config is loaded) ----
// This process can run under NODE_ENV=production, which would trip the
// production guard in loadConfig() (rejects localhost DATABASE_URL). Force
// test mode so the local harness can run — same as e2e-d7.ts.
process.env.NODE_ENV = process.env.NODE_ENV === "production" ? "test" : process.env.NODE_ENV;
// Default to the harness's own database. It points at `aegix_loadtest`, NOT
// `aegix` or `aegix_test`, so test:e2e-d7 and loadtest:public never clobber
// each other (D7-S requirement). This OVERRIDES any ambient DATABASE_URL
// (the repo .env points at `aegix`), so the harness is guaranteed isolated.
// Set LOADTEST_PUBLIC_DATABASE_URL to run against a different database.
process.env.DATABASE_URL = process.env.LOADTEST_PUBLIC_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aegix_loadtest";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "@aegix/config";
import {
  createDb,
  createWalletRepo,
  createAnalysisJobRepo,
  createWalletAnalyticsRepo,
  createBehavioralFeatureRepo,
  createIntelligenceRepo,
  createCorrelationRepo,
  createSavedComparisonRepo,
  createMonitorRepo,
  createMonitorAlertRulesRepo,
  createWalletAuthRepo
} from "@aegix/database";
import { createCache } from "@aegix/cache";
import { isValidSolanaAddress } from "@aegix/blockchain";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import {
  runComparison,
  canonicalComparePair,
  compareCacheKey,
  compareLockKey,
  cachedComparison,
  type CompareContext
} from "../apps/api/src/compare.js";

// ---- CLI flags, parsed exactly like load-test.ts (`--key=value`) ----
interface Options {
  concurrency: number;
  wallets: number;
  sameWallet: number;
  samePair: number;
  users: number;
  timeoutSeconds: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { concurrency: 5, wallets: 20, sameWallet: 50, samePair: 25, users: 20, timeoutSeconds: 120 };
  for (const arg of argv) {
    const [key, value] = arg.split("=");
    switch (key) {
      case "--concurrency": opts.concurrency = Number(value); break;
      case "--wallets": opts.wallets = Number(value); break;
      case "--same-wallet": opts.sameWallet = Number(value); break;
      case "--same-pair": opts.samePair = Number(value); break;
      case "--users": opts.users = Number(value); break;
      case "--timeout": opts.timeoutSeconds = Number(value); break;
      default: throw new Error(`unknown flag: ${key}`);
    }
  }
  for (const [name, v] of Object.entries({ concurrency: opts.concurrency, wallets: opts.wallets, sameWallet: opts.sameWallet, samePair: opts.samePair, users: opts.users, timeoutSeconds: opts.timeoutSeconds })) {
    if (!Number.isFinite(v) || v < 1) throw new Error(`--${name} must be a number >= 1`);
  }
  return opts;
}

/** Small helper for a short random salt (per-run namespace). */
function saltHex(len: number): string {
  return randomUUID().replace(/-/g, "").slice(0, len);
}

// ---- Deterministic eligible-wallet fixtures ----
// Deterministic Ed25519 keypairs → valid base58 Solana addresses. These are
// never fetched on-chain (the harness seeds analyzed wallets directly), but
// they are genuinely valid addresses, mirroring the E2E's "UNKNOWN_ACCOUNT
// eligible" fixture approach. A per-run salt makes addresses unique across
// runs so the harness is idempotent even without a schema reset (e.g. when a
// foreign DATABASE_URL is supplied).
const RUN_SALT = saltHex(8);

export interface WalletFixture {
  priv: Uint8Array;
  address: string;
}

function walletFromSeed(seed: string): WalletFixture {
  const priv = createHash("sha256").update(`aegix-loadtest:${RUN_SALT}:${seed}`).digest();
  const pub = ed25519.getPublicKey(priv);
  return { priv, address: base58.encode(pub) };
}

// ---- Analysis admission: cache key / lock key (D3-C, D1-D6 cache+dedup) ----
// These mirror server.ts exactly (ENGINE_SCOPE="full", pipeline v1.0.0); they
// are replicated here because they are not exported, and they are the exact
// cache/lock keys the server uses so the measured dedup is trustworthy.
const CACHE_PREFIX = "analysis-result";
const ENGINE_SCOPE = "full";
const PIPELINE_VERSION = "aegix-pipeline-v1.0.0";
function analysisCacheKey(address: string): string {
  return `${CACHE_PREFIX}:${address}`;
}
function analysisLockKey(address: string): string {
  return `analysis-lock:solana:${address}:${ENGINE_SCOPE}:${PIPELINE_VERSION}`;
}

// ---- Shared harness state ----
const opts = parseArgs(process.argv.slice(2));
const config = loadConfig();
let sql = createDb(config.DATABASE_URL);
let walletRepo: ReturnType<typeof createWalletRepo>;
let jobRepo: ReturnType<typeof createAnalysisJobRepo>;
let analyticsRepo: ReturnType<typeof createWalletAnalyticsRepo>;
let behaviorRepo: ReturnType<typeof createBehavioralFeatureRepo>;
let intelRepo: ReturnType<typeof createIntelligenceRepo>;
let correlationRepo: ReturnType<typeof createCorrelationRepo>;
let savedComparisonRepo: ReturnType<typeof createSavedComparisonRepo>;
let monitorRepo: ReturnType<typeof createMonitorRepo>;
let rulesRepo: ReturnType<typeof createMonitorAlertRulesRepo>;
let cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
let ctx: CompareContext;

/** (Re)binds all repositories to the CURRENT `sql`. Called after the clean-state
 *  reset, which ends and replaces the connection — repos must not capture a
 *  stale connection. */
function initRepos(): void {
  walletRepo = createWalletRepo(sql);
  jobRepo = createAnalysisJobRepo(sql);
  analyticsRepo = createWalletAnalyticsRepo(sql);
  behaviorRepo = createBehavioralFeatureRepo(sql);
  intelRepo = createIntelligenceRepo(sql);
  correlationRepo = createCorrelationRepo(sql);
  savedComparisonRepo = createSavedComparisonRepo(sql);
  monitorRepo = createMonitorRepo(sql);
  rulesRepo = createMonitorAlertRulesRepo(sql);
  ctx = { sql, config };
}
initRepos();

const timeoutMs = opts.timeoutSeconds * 1000;
const ENGINE_VERSION = "loadtest-v1.0.0";
const freshUntil = () => new Date(Date.now() + 3600_000).toISOString(); // 1h fresh (== ANALYSIS_CACHE_TTL_SECONDS)

/** Per-scenario metric collector, snapshotted after each scenario. */
interface Metrics {
  cacheHits: number;
  dedupHits: number;
  jobsCreated: number;
  computeRuns: number;
  errors: number;
  requests: number;
  latencies: number[];
}
function freshMetrics(): Metrics {
  return { cacheHits: 0, dedupHits: 0, jobsCreated: 0, computeRuns: 0, errors: 0, requests: 0, latencies: [] };
}

/** Shared atomic counter so N workers issue exactly `total` requests in total
 *  (regardless of concurrency) — mirrors the worker() pattern in load-test.ts. */
function makeCounter(total: number): () => number {
  let next = 0;
  return () => (next < total ? next++ : -1);
}
function summarize(m: Metrics, totalRequests?: number): { requests: number; jobs: number; computeRuns: number; cacheHits: number; dedupHits: number; errors: number; avg_ms: number; p50_ms: number; p95_ms: number; reuseRatio: number } {
  const lat = [...m.latencies].sort((a, b) => a - b);
  const avg = lat.length ? Math.round(lat.reduce((s, r) => s + r, 0) / lat.length) : 0;
  const p50 = lat.length ? lat[Math.floor(lat.length * 0.5)] ?? 0 : 0;
  const p95 = lat.length ? lat[Math.floor(lat.length * 0.95)] ?? 0 : 0;
  const total = totalRequests ?? m.requests ?? 1;
  // Every request resolves to exactly one of: cacheHit | dedupHit | created work.
  // reuseRatio = fraction served WITHOUT creating new expensive work.
  const reuseRatio = Math.round(((m.cacheHits + m.dedupHits) / total) * 1000) / 1000;
  return {
    requests: total,
    jobs: m.jobsCreated + m.computeRuns,
    computeRuns: m.computeRuns,
    cacheHits: m.cacheHits,
    dedupHits: m.dedupHits,
    errors: m.errors,
    avg_ms: avg,
    p50_ms: p50,
    p95_ms: p95,
    reuseRatio
  };
}

/** Emulates the server's analysis admission path offline (validate → cache/reuse
 *  → dedup → new work, D3-C §24-§26). Classification is the only step skipped
 *  because it needs live RPC; every target wallet is pre-seeded eligible. */
async function admitAnalysis(m: Metrics, address: string, userId: string | null): Promise<void> {
  const t0 = Date.now();
  m.requests += 1;
  // 1. Fresh cached analysis -> return immediately (D3-C §24: cache hits do
  //    not consume quota, and are the "reuse" path for shared public wallets).
  const cached = await cache.getJson<{ analysisId: string }>(analysisCacheKey(address));
  if (cached?.analysisId) {
    m.cacheHits += 1;
    m.latencies.push(Date.now() - t0);
    return;
  }
  // 2. Distributed lock: deduplicate concurrent analyses for the same wallet.
  const lockKey = analysisLockKey(address);
  const acquired = await cache.acquireLock(lockKey, 300);
  if (!acquired) {
    const existing = await cache.getJson<{ analysisId: string }>(analysisCacheKey(address));
    if (existing?.analysisId) {
      m.cacheHits += 1;
      m.latencies.push(Date.now() - t0);
      return;
    }
    m.dedupHits += 1; // ANALYSIS_IN_PROGRESS / dedup
    m.latencies.push(Date.now() - t0);
    return;
  }
  try {
    // 3. Recent READY analysis -> reuse (fresh_until in future).
    const wallet = await walletRepo.findOrCreate("solana", address);
    const latest = await jobRepo.latestForWallet(wallet.id);
    if (latest && latest.fresh_until && new Date(latest.fresh_until) > new Date()) {
      await cache.setJson(analysisCacheKey(address), { analysisId: latest.id }, config.ANALYSIS_CACHE_TTL_SECONDS);
      m.cacheHits += 1;
      m.latencies.push(Date.now() - t0);
      return;
    }
    // 4. Admission + create job (the only "expensive" step; bounded by the
    //    lock so only one concurrent request creates work).
    const job = await jobRepo.create({ walletId: wallet.id, requestedBy: userId, analysisType: "full", priority: "standard" });
    m.jobsCreated += 1;
    await cache.setJson(analysisCacheKey(address), { analysisId: job.id }, config.ANALYSIS_CACHE_TTL_SECONDS);
    m.latencies.push(Date.now() - t0);
  } finally {
    await cache.releaseLock(lockKey);
  }
}

/** Emulates the server's /v1/compare admission with symmetric cache+dedup
 *  (D5-I §25-§26): canonical pair key means (A,B) == (B,A). */
async function compareWithDedup(m: Metrics, walletA: string, walletB: string): Promise<void> {
  const t0 = Date.now();
  m.requests += 1;
  const pairId = canonicalComparePair(walletA, walletB);
  const hit = await cachedComparison(ctx, pairId);
  if (hit) {
    m.cacheHits += 1;
    m.latencies.push(Date.now() - t0);
    return;
  }
  const acquired = await cache.acquireLock(compareLockKey(pairId), 120);
  if (!acquired) {
    const existing = await cachedComparison(ctx, pairId);
    if (existing) {
      m.cacheHits += 1;
      m.latencies.push(Date.now() - t0);
      return;
    }
    m.dedupHits += 1;
    m.latencies.push(Date.now() - t0);
    return;
  }
  try {
    const result = await runComparison(ctx, { walletA, walletB });
    m.computeRuns += 1;
    await correlationRepo.upsert(result.correlation);
    await cache.setJson(compareCacheKey(pairId), result, config.CORRELATION_CACHE_TTL_SECONDS);
    m.latencies.push(Date.now() - t0);
  } finally {
    await cache.releaseLock(compareLockKey(pairId));
  }
}

// ---- Seeding helpers ----
/** Seeds an analyzed wallet exactly like e2e-d7.ts / load-test-correlation.ts:
 *  writes transactions + transfers + behavioral features, marks the job READY
 *  (fresh), and writes an exposure score so compare/x-ray have data. No RPC. */
async function seedAnalyzedWallet(address: string, partners: string[]): Promise<{ walletId: string; jobId: string }> {
  const wallet = await walletRepo.findOrCreate("solana", address);
  const job = await jobRepo.create({ walletId: wallet.id, requestedBy: null, analysisType: "full", priority: "free" });
  let txN = 0;
  for (const partner of partners) {
    for (let i = 0; i < 4; i++) {
      txN += 1;
      const tx = await analyticsRepo.insertTransaction({
        signature: `lt-${address.slice(0, 5)}-${txN}`,
        slot: 1,
        blockTime: `2026-02-0${(txN % 9) + 1}T12:00:00Z`,
        walletId: wallet.id,
        success: true,
        fee: 5000,
        transactionClass: "USER_WALLET",
        rawProvider: "loadtest",
        parserVersion: ENGINE_VERSION
      });
      await analyticsRepo.insertTransfers([{
        transaction_id: tx.id,
        from_address: partner,
        to_address: address,
        asset_type: "SOL",
        mint: null,
        amount_raw: String(10 + i + txN),
        amount_normalized: String(10 + i + txN),
        transfer_type: "TRANSFER",
        block_time: `2026-02-0${(txN % 9) + 1}T12:00:00Z`
      }]);
    }
  }
  await behaviorRepo.upsertFeatures(wallet.id, [
    { featureName: "activityHourDistribution", valueNumber: null, valueJson: { "10": 8, "11": 6 }, sampleSize: 20, engineVersion: ENGINE_VERSION },
    { featureName: "weekdayDistribution", valueNumber: null, valueJson: { "1": 14 }, sampleSize: 20, engineVersion: ENGINE_VERSION }
  ]);
  await jobRepo.markCompleted(job.id, {
    chainDataUntil: new Date().toISOString(),
    freshUntil: freshUntil()
  }, {
    transactionsParsed: txN * 2,
    parserFailures: 0,
    rpcFailures: 0,
    parserSuccessRate: 100,
    semanticCoverage: 85,
    fullyParsed: txN * 2,
    partiallyParsed: 0,
    genericParsed: 0,
    unknownProgramCount: 0,
    historyStart: "2026-02-01T00:00:00Z",
    historyEnd: "2026-02-10T00:00:00Z",
    dataQualityScore: 90,
    grade: "HIGH"
  });
  await intelRepo.insertScore({
    analysisId: job.id,
    walletId: wallet.id,
    overallScore: 42,
    dimensions: {
      identityLinkability: 40, fundingExposure: 60, walletClusterExposure: 50,
      behavioralFingerprint: 30, counterpartyExposure: 70, entityExposure: 20,
      transactionPatternExposure: 35
    },
    overallConfidence: 0.82,
    scoringVersion: "score-v1.0.0"
  });
  return { walletId: String(wallet.id), jobId: job.id };
}

/** Creates an authenticated user via repos (profile + wallet-identity bind),
 *  matching e2e-d7.ts's wallet-auth user model WITHOUT the Fastify server.
 *  Deterministic per seed and idempotent across runs (RUN_SALT namespaces the
 *  wallets). This mirrors the repo-level approach the E2E uses in its setup
 *  and avoids depending on the challenge/signature HTTP round-trip. */
async function createUser(seed: string): Promise<{ userId: string; wallet: string; token: string }> {
  const wf = walletFromSeed(seed);
  if (!isValidSolanaAddress(wf.address)) throw new Error(`generated address is not a valid Solana address: ${wf.address}`);
  const walletAuthRepo = createWalletAuthRepo(sql);
  const userId = randomUUID();
  // Profile is the stable internal identity; primary_wallet is the login wallet.
  // Wallets are namespaced by RUN_SALT so they are unique per run — a plain
  // insert suffices (the partial unique index on primary_wallet is not
  // referenced by ON CONFLICT, so we avoid that clause entirely).
  await sql`
    insert into profiles (id, display_name, plan, primary_wallet)
    values (${userId}, ${`loadtest-user-${seed}`}, 'free', ${wf.address})
  `;
  // Bind the wallet identity (idempotent on user_id + wallet_address).
  await walletAuthRepo.bindWallet(userId, wf.address);
  return { userId, wallet: wf.address, token: `loadtest-token-${RUN_SALT}-${seed}` };
}

async function main(): Promise<void> {
  console.log("\n=== D7 PUBLIC MULTI-USER LOAD / ADMISSION VALIDATION ===\n");
  console.log(`flags: concurrency=${opts.concurrency} wallets=${opts.wallets} same-wallet=${opts.sameWallet} same-pair=${opts.samePair} users=${opts.users} timeout=${opts.timeoutSeconds}s`);
  console.log(`db: ${config.DATABASE_URL}  redis: ${config.REDIS_URL}  run-salt=${RUN_SALT}`);

  const isOwnDb = config.DATABASE_URL.includes("aegix_loadtest");
  if (isOwnDb) {
    // Clean-state reset for determinism — only the harness's own database.
    console.log("\nresetting aegix_loadtest database to clean state...");
    await sql.unsafe("drop schema public cascade; create schema public;");
    await sql.end();
    execFileSync("pnpm", ["--filter", "@aegix/database", "migrate"], { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
    sql = createDb(config.DATABASE_URL);
    initRepos(); // the reset ended the old connection; rebind repos to the new one
  } else {
    console.log("\nNOTE: DATABASE_URL is not aegix_loadtest — skipping schema reset; unique per-run wallets keep this idempotent.");
  }

  // ---- Setup fixtures ----
  // Two canonical pair wallets (analyzed) for the same-pair storm + isolation.
  const pairA = walletFromSeed("pair-A").address;
  const pairB = walletFromSeed("pair-B").address;
  await seedAnalyzedWallet(pairA, [pairB]);
  await seedAnalyzedWallet(pairB, [pairA]);

  // Same-wallet storm target (analyzed, fresh READY) — the "shared public wallet".
  const stormWallet = walletFromSeed("storm").address;
  await seedAnalyzedWallet(stormWallet, [pairA]);

  // Distinct-wallet pool for throughput (bounded by --wallets).
  const distinctWallets: string[] = [];
  for (let i = 0; i < opts.wallets; i++) {
    const wf = walletFromSeed(`dw-${i}`);
    await seedAnalyzedWallet(wf.address, [pairA, pairB]);
    distinctWallets.push(wf.address);
  }
  console.log(`\nseeded ${distinctWallets.length + 3} analyzed wallets (3 fixtures + pair + storm).`);

  // ================= SCENARIO 1: multi-user setup =================
  const userSeedStart = Date.now();
  const users: Array<{ userId: string; wallet: string; token: string }> = [];
  let userErrors = 0;
  for (let i = 0; i < opts.users; i++) {
    try {
      users.push(await createUser(`user-${i}`));
    } catch (err) {
      userErrors += 1;
      console.error(`✖ user ${i} creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const userCreateMs = Date.now() - userSeedStart;
  const distinctUserIds = new Set(users.map((u) => u.userId));
  const distinctWalletsPerUser = new Set(users.map((u) => u.wallet));
  console.log(`\n[Scenario 1] multi-user setup: ${users.length}/${opts.users} users created in ${Math.round(userCreateMs / 10) / 100}s (${userErrors} errors)`);
  console.log(`  distinct userIds: ${distinctUserIds.size} / users: ${users.length}  |  distinct login wallets: ${distinctWalletsPerUser.size}`);
  const usersOk = users.length === opts.users && userErrors === 0;

  // ================= SCENARIO 2a: same-wallet storm (warm, analyzed) =================
  let m = freshMetrics();
  const warmStart = Date.now();
  const nextWarm = makeCounter(opts.sameWallet);
  const warmWorkers = Array.from({ length: Math.min(opts.concurrency, opts.sameWallet) }, async () => {
    for (let i = nextWarm(); i >= 0; i = nextWarm()) {
      try {
        await Promise.race([
          admitAnalysis(m, stormWallet, null),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`wait timeout after ${opts.timeoutSeconds}s`)), timeoutMs))
        ]);
      } catch (err) {
        m.errors += 1;
        console.error(`✖ warm same-wallet request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  await Promise.all(warmWorkers);
  const warmMs = Date.now() - warmStart;
  const warmSum = summarize(m, opts.sameWallet);
  console.log(`\n[Scenario 2a] same-wallet storm (warm, wallet ALREADY analyzed)`);
  console.log(`  desc: ${opts.sameWallet} concurrent admission requests on ONE analyzed public wallet`);
  console.log(`  duration: ${Math.round(warmMs / 10) / 100}s  reuse_ratio: ${warmSum.reuseRatio}`);
  console.log(`  jobsCreated=${warmSum.jobs} (want 0), cacheHits=${warmSum.cacheHits}, dedupHits=${warmSum.dedupHits}, errors=${warmSum.errors}`);
  const warmOk = warmSum.jobs === 0 && warmSum.errors === 0 && warmSum.cacheHits > 0;

  // ================= SCENARIO 2b: same-wallet storm (cold, no prior analysis) =================
  m = freshMetrics();
  const coldWallet = walletFromSeed("cold-storm").address;
  await cache.del(analysisCacheKey(coldWallet)); // start truly cold
  const coldStart = Date.now();
  const nextCold = makeCounter(opts.sameWallet);
  const coldWorkers = Array.from({ length: Math.min(opts.concurrency, opts.sameWallet) }, async () => {
    for (let i = nextCold(); i >= 0; i = nextCold()) {
      try {
        await Promise.race([
          admitAnalysis(m, coldWallet, users[0]?.userId ?? null),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`wait timeout after ${opts.timeoutSeconds}s`)), timeoutMs))
        ]);
      } catch (err) {
        m.errors += 1;
        console.error(`✖ cold same-wallet request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  await Promise.all(coldWorkers);
  const coldMs = Date.now() - coldStart;
  const coldSum = summarize(m, opts.sameWallet);
  console.log(`\n[Scenario 2b] same-wallet storm (cold, NO prior analysis)`);
  console.log(`  desc: ${opts.sameWallet} concurrent admission requests on one never-analyzed eligible address`);
  console.log(`  duration: ${Math.round(coldMs / 10) / 100}s  reuse_ratio: ${coldSum.reuseRatio}`);
  console.log(`  jobsCreated=${coldSum.jobs} (want <=1 via lock dedup), cacheHits=${coldSum.cacheHits}, dedupHits=${coldSum.dedupHits}, errors=${coldSum.errors}`);
  const coldOk = coldSum.jobs <= 1 && coldSum.errors === 0;

  // ================= SCENARIO 3: same-pair storm (canonical reuse) =================
  m = freshMetrics();
  // Clear compare cache so we measure a cold dedup/one compute.
  await cache.del(compareCacheKey(canonicalComparePair(pairA, pairB)));
  const canonicalSymmetry = canonicalComparePair(pairA, pairB) === canonicalComparePair(pairB, pairA);
  const totalPair = opts.samePair * 2; // A/B + B/A
  const pairStart = Date.now();
  const nextPair = makeCounter(totalPair);
  const pairWorkers = Array.from({ length: Math.min(opts.concurrency, totalPair) }, async () => {
    for (let i = nextPair(); i >= 0; i = nextPair()) {
      const forward = i % 2 === 0; // even -> (A,B), odd -> (B,A)
      const wa = forward ? pairA : pairB;
      const wb = forward ? pairB : pairA;
      try {
        await Promise.race([
          compareWithDedup(m, wa, wb),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`wait timeout after ${opts.timeoutSeconds}s`)), timeoutMs))
        ]);
      } catch (err) {
        m.errors += 1;
        console.error(`✖ same-pair request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  await Promise.all(pairWorkers);
  const pairMs = Date.now() - pairStart;
  const pairSum = summarize(m, totalPair);
  console.log(`\n[Scenario 3] same-pair storm (canonical reuse)`);
  console.log(`  desc: ${opts.samePair} × A/B + ${opts.samePair} × B/A = ${totalPair} concurrent compares on ONE canonical pair`);
  console.log(`  duration: ${Math.round(pairMs / 10) / 100}s  reuse_ratio: ${pairSum.reuseRatio}`);
  console.log(`  canonicalComparePair(A,B)===canonicalComparePair(B,A): ${canonicalSymmetry}`);
  console.log(`  computes=${pairSum.computeRuns} (want 1 — every A/B+B/A shares one expensive run)`);
  console.log(`  cacheHits=${pairSum.cacheHits}, dedupHits=${pairSum.dedupHits}, errors=${pairSum.errors}`);
  const pairOk = canonicalSymmetry && (pairSum.computeRuns <= 1) && pairSum.errors === 0;

  // ================= SCENARIO 4: distinct-wallet throughput (cache-only, 0 RPC) =================
  m = freshMetrics();
  const dwStart = Date.now();
  const nextDw = makeCounter(distinctWallets.length);
  const dwWorkers = Array.from({ length: Math.min(opts.concurrency, distinctWallets.length) }, async () => {
    for (let i = nextDw(); i >= 0; i = nextDw()) {
      const address = distinctWallets[i]!;
      try {
        await Promise.race([
          admitAnalysis(m, address, null),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`wait timeout after ${opts.timeoutSeconds}s`)), timeoutMs))
        ]);
      } catch (err) {
        m.errors += 1;
        console.error(`✖ distinct-wallet request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  await Promise.all(dwWorkers);
  const dwMs = Date.now() - dwStart;
  const dwSum = summarize(m, distinctWallets.length);
  const dwThroughput = dwMs > 0 ? Math.round((distinctWallets.length / dwMs) * 1000 * 10) / 10 : 0;
  console.log(`\n[Scenario 4] different-wallet throughput (cache-only, 0 RPC)`);
  console.log(`  desc: ${distinctWallets.length} distinct-wallet admission requests on pre-seeded analyzed wallets`);
  console.log(`  duration: ${Math.round(dwMs / 10) / 100}s  throughput: ${dwThroughput} req/s`);
  console.log(`  jobsCreated=${dwSum.jobs} (want 0), cacheHits=${dwSum.cacheHits}, errors=${dwSum.errors}, p50=${dwSum.p50_ms}ms, p95=${dwSum.p95_ms}ms`);
  const dwOk = dwSum.jobs === 0 && dwSum.errors === 0 && dwSum.cacheHits === distinctWallets.length;

  // ================= SCENARIO 5: cross-user isolation =================
  const userA = users[0];
  const userB = users[1];
  let isolationSavedOk = false;
  let isolationMonitorOk = false;
  if (userA && userB) {
    const persisted = await correlationRepo.findByPair(pairA, pairB);
    const saved = await savedComparisonRepo.save({
      userId: userA.userId,
      pairKey: canonicalComparePair(pairA, pairB),
      walletA: pairA,
      walletB: pairB,
      comparisonResultId: persisted?.id ?? null,
      label: "loadtest private",
      notes: "only user A may see this"
    });
    const bRead = await savedComparisonRepo.getForUser(userB.userId, saved.id);
    const bList = await savedComparisonRepo.listForUser(userB.userId, { limit: 50, offset: 0, sort: "created_at", order: "desc" });
    const aList = await savedComparisonRepo.listForUser(userA.userId, { limit: 50, offset: 0, sort: "created_at", order: "desc" });
    const bSeesA = bList.some((s) => s.id === saved.id);
    const aSeesOwn = aList.some((s) => s.id === saved.id);
    isolationSavedOk = bRead === null && !bSeesA && aSeesOwn;

    const aWalletId = (await walletRepo.findByAddress("solana", stormWallet))!.id;
    const bWalletId = (await walletRepo.findByAddress("solana", distinctWallets[0]!))!.id;
    const aMonitor = await monitorRepo.create({ userId: userA.userId, walletId: aWalletId, savedAnalysisId: null, scheduleType: "DAILY", baselineAnalysisId: null, nextCheckAt: new Date(Date.now() + 86_400_000).toISOString() });
    await rulesRepo.createWithMonitor(aMonitor.id, { minimumSeverity: "HIGH", minimumConfidence: 0.6, overallScoreDeltaThreshold: 10, cooldownHours: 24 });
    const bMonitor = await monitorRepo.create({ userId: userB.userId, walletId: bWalletId, savedAnalysisId: null, scheduleType: "DAILY", baselineAnalysisId: null, nextCheckAt: new Date(Date.now() + 86_400_000).toISOString() });
    await rulesRepo.createWithMonitor(bMonitor.id, { minimumSeverity: "HIGH", minimumConfidence: 0.6, overallScoreDeltaThreshold: 10, cooldownHours: 24 });
    const aMonitors = await monitorRepo.listForUser(userA.userId);
    const bMonitors = await monitorRepo.listForUser(userB.userId);
    const aSeesOnlyA = aMonitors.length === 1 && aMonitors[0]!.id === aMonitor.id;
    const bSeesOnlyB = bMonitors.length === 1 && bMonitors[0]!.id === bMonitor.id;
    isolationMonitorOk = aSeesOnlyA && bSeesOnlyB;
  } else {
    console.error("✖ need at least 2 users to validate cross-user isolation");
  }
  console.log(`\n[Scenario 5] cross-user isolation (${users.length} users)`);
  console.log(`  tests: user B cannot read user A's saved comparison: ${isolationSavedOk}`);
  console.log(`         monitor lists do not cross users:            ${isolationMonitorOk}`);

  // ================= SUMMARY =================
  console.log("\n=== LOAD TEST SUMMARY ===");
  const table = [
    { scenario: "multi-user setup", metric: "users created", value: `${users.length}/${opts.users}` },
    { scenario: "multi-user setup", metric: "distinct userIds", value: distinctUserIds.size },
    { scenario: "multi-user setup", metric: "distinct login wallets", value: distinctWalletsPerUser.size },
    { scenario: "same-wallet storm (warm)", metric: "requests", value: warmSum.requests },
    { scenario: "same-wallet storm (warm)", metric: "jobs created", value: warmSum.jobs },
    { scenario: "same-wallet storm (warm)", metric: "cache hits", value: warmSum.cacheHits },
    { scenario: "same-wallet storm (warm)", metric: "dedup hits", value: warmSum.dedupHits },
    { scenario: "same-wallet storm (warm)", metric: "reuse ratio (no new work)", value: warmSum.reuseRatio },
    { scenario: "same-wallet storm (warm)", metric: "errors", value: warmSum.errors },
    { scenario: "same-wallet storm (warm)", metric: "RPC calls", value: 0 },
    { scenario: "same-wallet storm (cold)", metric: "requests", value: coldSum.requests },
    { scenario: "same-wallet storm (cold)", metric: "jobs created (lock dedup)", value: coldSum.jobs },
    { scenario: "same-wallet storm (cold)", metric: "cache hits", value: coldSum.cacheHits },
    { scenario: "same-wallet storm (cold)", metric: "dedup hits", value: coldSum.dedupHits },
    { scenario: "same-wallet storm (cold)", metric: "reuse ratio (no new work)", value: coldSum.reuseRatio },
    { scenario: "same-wallet storm (cold)", metric: "errors", value: coldSum.errors },
    { scenario: "same-pair storm", metric: "total compares", value: totalPair },
    { scenario: "same-pair storm", metric: "canonical symmetry", value: canonicalSymmetry },
    { scenario: "same-pair storm", metric: "computes (distinct expensive runs)", value: pairSum.computeRuns },
    { scenario: "same-pair storm", metric: "cache hits", value: pairSum.cacheHits },
    { scenario: "same-pair storm", metric: "dedup hits", value: pairSum.dedupHits },
    { scenario: "same-pair storm", metric: "reuse ratio (no new work)", value: pairSum.reuseRatio },
    { scenario: "same-pair storm", metric: "errors", value: pairSum.errors },
    { scenario: "different-wallet", metric: "wallets", value: distinctWallets.length },
    { scenario: "different-wallet", metric: "requests", value: dwSum.requests },
    { scenario: "different-wallet", metric: "jobs created", value: dwSum.jobs },
    { scenario: "different-wallet", metric: "cache hits", value: dwSum.cacheHits },
    { scenario: "different-wallet", metric: "RPC calls", value: 0 },
    { scenario: "different-wallet", metric: "throughput req/s", value: dwThroughput },
    { scenario: "different-wallet", metric: "p50 ms", value: dwSum.p50_ms },
    { scenario: "different-wallet", metric: "p95 ms", value: dwSum.p95_ms },
    { scenario: "different-wallet", metric: "errors", value: dwSum.errors },
    { scenario: "cross-user isolation", metric: "saved-comparison isolated", value: isolationSavedOk },
    { scenario: "cross-user isolation", metric: "monitor lists isolated", value: isolationMonitorOk }
  ];
  console.table(table);

  // Explicitly report any NOT MEASURED items (document, never guess).
  console.log("\n---- NOT MEASURED (documented, not guessed) ----");
  console.log("1. Full HTTP request latency through the Fastify server: NOT MEASURED — the harness drives the in-process admission/comparison services directly (offline, no live server), matching load-test-correlation.ts. Real HTTP overhead is out of scope.");
  console.log("2. Live mainnet RPC calls / RPC latency: NOT MEASURED — this harness is offline by design (net-zero RPC budget); RPC calls reported are 0. See load-test.ts for a live-RPC harness.");
  console.log("3. Live worker queue-wait / worker-drain timing: NOT MEASURED — the harness uses cache-only admission (no BullMQ jobs enqueued), so queue wait/worker duration is not exercised here. See load-test.ts / test:e2e-d7.");
  console.log("4. Rate-limit / quota / SERVICE_BUSY rejection behavior under genuine overload: NOT MEASURED — the bounded size (~120 requests) stays under MAX_QUEUE_DEPTH=50/MAX_ACTIVE_GLOBAL=30 admission caps, so no rejection path is triggered. Explicitly bounded by design.");

  // ---- Verdicts (conservative, honest; never inflated) ----
  console.log("\n---- VERDICTS ----");
  const verdicts = [
    ["multi-user setup", usersOk],
    ["same-wallet warm dedup (0 jobs, >0 cache hits, 0 errors)", warmOk],
    ["same-wallet cold dedup (<=1 job via lock, 0 errors)", coldOk],
    ["same-pair canonical reuse (symmetry + <=1 compute, 0 errors)", pairOk],
    ["different-wallet cache-only (0 jobs, all cache hits, 0 errors)", dwOk],
    ["cross-user isolation (saved-comparison + monitors)", isolationSavedOk && isolationMonitorOk]
  ];
  let allPass = true;
  for (const [name, ok] of verdicts) {
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`);
    if (!ok) allPass = false;
  }

  await cache.close();
  await sql.end();
  console.log(`\n${allPass ? "PASS" : "FAIL"} — run completed cleanly (users=${users.length}, wallets=${distinctWallets.length})`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("loadtest:public crashed:", err);
  void sql.end().catch(() => {});
  void cache.close().catch(() => {});
  process.exit(1);
});
