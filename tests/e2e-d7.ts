/**
 * D7 public-product end-to-end test (docs/milestone-d7.md D7-*).
 *
 * Exercises the real Fastify server via `app.inject()` — a full HTTP request
 * against the route handlers with no live server. Clean-state reset
 * (drop schema → migrate 0001..0008), then seed analyzed wallets through the
 * repos/pipeline exactly like e2e-d6.ts (never enqueueing a real BullMQ
 * analysis job, which would need a worker), then drive the public routes:
 *
 *   Flow 1   new-user wallet auth — challenge → sign (ed25519 + bs58) →
 *            verify → token; /v1/auth/me; replay rejection; wrong-domain.
 *   Flow 2   anonymous public analysis admission — eligible (cached/202),
 *            invalid → 400, non-eligible account → ACCOUNT_NOT_ANALYZABLE.
 *   Flow 3   wallet x-ray — score/confidence/dimensions/topSignals/
 *            attackPaths/engineVersions after seeding.
 *   Flow 4   compare — correlation/confidence/evidenceFamilies/
 *            relationshipPaths/clusters/commonality; canonical pair
 *            symmetry (A,B) == (B,A); self compare → DUPLICATE_WALLET.
 *   Flow 5   save comparison (authenticated) — create/list/update/detail
 *            with stale flag.
 *   Flow 6   monitor + in-app notification.
 *   Flow 7   developer API — create/list/status/rotate/revoke.
 *   Flow 8   webhook management — create/list/test/rotate/disable/enable/
 *            delete + consumer signature verification + SSRF policy.
 *   Flow 9   cross-user isolation (saved comparisons, monitors, webhooks).
 *   Flow 10  returning user — logout, re-login, same userId + data intact.
 *
 * Requires local Postgres + Redis (docker compose). Resets the database.
 * Run: pnpm test:e2e-d7
 */

import { execFileSync } from "node:child_process";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import {
  createDb,
  createWalletRepo,
  createAnalysisJobRepo,
  createWalletAnalyticsRepo,
  createBehavioralFeatureRepo,
  createIntelligenceRepo,
  createCorrelationRepo,
  createNotificationRepo
} from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { verifyWebhookRequest, resolveWebhookDestination, SsrfBlockedError } from "@aegix/webhook-delivery";
import { signWebhookPayload } from "@aegix/webhook-delivery";
import { buildServer } from "../apps/api/src/server.js";
import { canonicalComparePair, runComparison } from "../apps/api/src/compare.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";
import type { BlockchainProvider } from "@aegix/blockchain";

// ---- Environment setup (must be set BEFORE config is loaded) ----
const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aegix_test";
requireSafeTestDatabaseReset(process.env, { databaseUrl: TEST_DB_URL });

if (!process.env.WEBHOOK_ENCRYPTION_KEY) {
  process.env.WEBHOOK_ENCRYPTION_KEY = "e2e-d7-public-product-webhook-encryption-key-0123456789";
}
process.env.WEBHOOK_DEV_ALLOW_PRIVATE = process.env.WEBHOOK_DEV_ALLOW_PRIVATE ?? "true";
process.env.WEBHOOK_ALLOWED_PORTS = process.env.WEBHOOK_ALLOWED_PORTS ?? "80,443,18765,18766";
process.env.EMAIL_ENABLED = "false";
process.env.ENABLE_EMAIL_NOTIFICATIONS = "false";
// Critical: the production target is wallet-only auth.
process.env.ENABLE_LEGACY_AUTH = "false";
process.env.AUTH_DOMAIN = process.env.AUTH_DOMAIN ?? "http://localhost:3000";
process.env.AUTH_APP_URI = process.env.AUTH_APP_URI ?? "http://localhost:3000";
process.env.ENABLE_NEW_ANALYSES = process.env.ENABLE_NEW_ANALYSES ?? "true";
process.env.ENABLE_CORRELATION_ANALYSIS = process.env.ENABLE_CORRELATION_ANALYSIS ?? "true";
process.env.ENABLE_SAVED_COMPARISONS = process.env.ENABLE_SAVED_COMPARISONS ?? "true";
process.env.ENABLE_DEVELOPER_API = process.env.ENABLE_DEVELOPER_API ?? "true";
process.env.ENABLE_MONITORING = process.env.ENABLE_MONITORING ?? "true";
process.env.ENABLE_WEBHOOK_DELIVERY = process.env.ENABLE_WEBHOOK_DELIVERY ?? "true";
process.env.ENABLE_POPULATION_COMMONALITY = process.env.ENABLE_POPULATION_COMMONALITY ?? "true";
process.env.DATABASE_URL = TEST_DB_URL;
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const config = loadConfig();
let sql = createDb(config.DATABASE_URL);

let pass = 0;
let fail = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`✔ ${name}`);
  } else {
    fail += 1;
    console.log(`✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- Deterministic eligible wallet fixtures ----
// These base58 addresses classify (via the live-RPC classifier) as
// UNKNOWN_ACCOUNT, which `isAnalysisEligible` accepts — so they pass the
// /v1/analyses and /v1/compare account gates. Their Ed25519 private keys are
// fixed so the same wallet can both sign the auth challenge AND be seeded as
// an analyzed wallet. (The deterministic fill(7) keys in e2e-d6 classify as
// PDA/program and are NOT eligible here, so we scan a fixed PRNG chain for
// eligible addresses.)
const WALLET_A = "6wJtbmjsbC3qcJyD5mp4T93Aa91LgR4NBjE5VbKMTouy";
const WALLET_A_PRIV = Uint8Array.from("47c89ef21edf3646c2586a0b6616eea8b102d821c0bc215925fa0381f621a45d".match(/.{2}/g)!.map((b) => parseInt(b, 16)));
const WALLET_B = "4AL8ZUMB4LBDSeKrkbsjGTSmmt7ydWna3ZyHoSGhkUVF";
const WALLET_B_PRIV = Uint8Array.from("e94189d50c0cd8dad2c116d166eae281e2226afcd7ce610302f427d5b060585d".match(/.{2}/g)!.map((b) => parseInt(b, 16)));
// A program/mint-like address used to prove non-eligible accounts are rejected.
const NON_ELIGIBLE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const fixtureProvider: BlockchainProvider = {
  chain: "solana",
  name: "recorded-e2e-fixture",
  validateAddress: () => true,
  async getAccountInfo(address) {
    if (address === NON_ELIGIBLE) {
      return { owner: "BPFLoader2111111111111111111111111111111111", executable: true, lamports: 1, dataLength: 1, data: "" };
    }
    return { owner: "11111111111111111111111111111111", executable: false, lamports: 1, dataLength: 0, data: "" };
  },
  async getSignatures() { return []; },
  async getTransaction() { return null; },
  async getTokenAccounts() { return []; },
  async getBalance() { return 0; },
  async getLatestBlockHeight() { return 1; }
};

async function signMessage(priv: Uint8Array, message: string): Promise<string> {
  const sig = ed25519.sign(new TextEncoder().encode(message), priv);
  return base58.encode(sig);
}

/** Issues a challenge over HTTP, signs it, verifies, and returns the session. */
async function login(
  app: Awaited<ReturnType<typeof buildServer>>,
  wallet: string,
  priv: Uint8Array
): Promise<{ userId: string; token: string }> {
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet } });
  const chBody = challenge.json();
  if (challenge.statusCode !== 200 || !chBody?.data?.message) throw new Error(`challenge failed: ${challenge.statusCode} ${JSON.stringify(chBody)}`);
  const sig = await signMessage(priv, chBody.data.message);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/wallet/verify",
    payload: { challengeId: chBody.data.challengeId, wallet, signature: sig, nonce: chBody.data.nonce }
  });
  const vBody = verify.json();
  if (verify.statusCode !== 200 || !vBody?.data?.token) throw new Error(`verify failed: ${verify.statusCode} ${JSON.stringify(vBody)}`);
  return { userId: vBody.data.user.id, token: vBody.data.token };
}

/**
 * Seeds an analyzed wallet exactly like e2e-d6.ts: creates the wallet/job,
 * writes raw transactions + transfers, behavioral features, marks the job
 * READY (fresh), and writes the intelligence score/signals/path so the
 * x-ray + compare endpoints have data. No BullMQ worker is required.
 */
async function seedAnalyzedWallet(address: string, partners: string[], freshUntil: string): Promise<{ walletId: string; jobId: string }> {
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const behaviorRepo = createBehavioralFeatureRepo(sql);
  const intelRepo = createIntelligenceRepo(sql);

  const wallet = await walletRepo.findOrCreate("solana", address);
  const job = await jobRepo.create({ walletId: wallet.id, requestedBy: null, analysisType: "full", priority: "free" });

  let txN = 0;
  for (const partner of partners) {
    for (let i = 0; i < 4; i++) {
      txN += 1;
      const tx = await analyticsRepo.insertTransaction({
        signature: `d7-${address.slice(0, 5)}-${txN}`,
        slot: 1,
        blockTime: `2026-06-0${(txN % 9) + 1}T12:00:00Z`,
        walletId: wallet.id,
        success: true,
        fee: 5000,
        transactionClass: "USER_WALLET",
        rawProvider: "e2e",
        parserVersion: "e2e"
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
        block_time: `2026-06-0${(txN % 9) + 1}T12:00:00Z`
      }]);
    }
  }
  await behaviorRepo.upsertFeatures(wallet.id, [
    { featureName: "activityHourDistribution", valueNumber: null, valueJson: { "10": 8, "11": 6 }, sampleSize: 20, engineVersion: "e2e" },
    { featureName: "weekdayDistribution", valueNumber: null, valueJson: { "1": 14 }, sampleSize: 20, engineVersion: "e2e" },
    { featureName: "protocolDistribution", valueNumber: null, valueJson: { "Rare Protocol": 5 }, sampleSize: 20, engineVersion: "e2e" }
  ]);
  await jobRepo.markCompleted(job.id, {
    chainDataUntil: new Date().toISOString(),
    freshUntil
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
    historyStart: "2026-06-01T00:00:00Z",
    historyEnd: "2026-06-10T00:00:00Z",
    dataQualityScore: 90,
    grade: "HIGH"
  });
  await intelRepo.insertScore({
    analysisId: job.id,
    walletId: wallet.id,
    overallScore: 42,
    dimensions: {
      identityLinkability: 40,
      fundingExposure: 60,
      walletClusterExposure: 50,
      behavioralFingerprint: 30,
      counterpartyExposure: 70,
      entityExposure: 20,
      transactionPatternExposure: 35
    },
    overallConfidence: 0.82,
    scoringVersion: "score-v1.0.0"
  });
  await intelRepo.insertSignals([{
    analysisId: job.id,
    walletId: wallet.id,
    signalType: "FUNDING_EXPOSURE",
    category: "funding",
    severity: 60,
    confidence: 0.75,
    title: "Direct funding exposure",
    summary: "Receives from a hub counterparty",
    evidence: [{ key: "counterparty", value: partners[0] ?? address, label: "Counterparty" }],
    engineVersion: "signal-v1.0.0"
  }]);
  await intelRepo.insertPaths([{
    analysisId: job.id,
    targetWalletId: wallet.id,
    rank: 1,
    pathType: "FUNDING_PATH",
    nodes: [{ type: "wallet", label: address }, { type: "wallet", label: partners[0] ?? address }],
    edges: [{ from: address, to: partners[0] ?? address }],
    pathScore: 55,
    confidenceScore: 0.7,
    summary: "Direct funding path",
    engineVersion: "path-v1.0.0"
  }]);
  return { walletId: wallet.id, jobId: job.id };
}

async function main(): Promise<void> {
  console.log("\n=== D7 PUBLIC-PRODUCT E2E ===\n");

  // Clean state (same as e2e-d6.ts).
  console.log("resetting database to clean state...");
  await sql.unsafe("drop schema public cascade; create schema public;");
  await sql.end();
  execFileSync("pnpm", ["--filter", "@aegix/database", "migrate"], { stdio: "inherit", env: process.env });
  sql = createDb(config.DATABASE_URL);
  const db = sql;

  const freshUntil = new Date(Date.now() + 3600_000).toISOString();
  const [seedA, seedB] = await Promise.all([
    seedAnalyzedWallet(WALLET_A, [WALLET_B], freshUntil),
    seedAnalyzedWallet(WALLET_B, [WALLET_A], freshUntil)
  ]);
  ok("setup: wallet A analyzed (READY, fresh)", seedA.jobId !== undefined);
  ok("setup: wallet B analyzed (READY, fresh)", seedB.jobId !== undefined);

  // Persist a real comparison result for (A,B) through the actual pipeline so
  // the saved-comparison detail and x-ray correlations have data.
  const corr = await runComparison({ sql: db, config }, { walletA: WALLET_A, walletB: WALLET_B });
  const correlationRepo = createCorrelationRepo(db);
  await correlationRepo.upsert(corr.correlation);
  const pairId = canonicalComparePair(WALLET_A, WALLET_B);
  ok("setup: comparison computed + persisted", corr.correlation.correlationScore >= 0, `score ${corr.correlation.correlationScore}`);

  const app = await buildServer({ config, provider: fixtureProvider });

  try {
    // ============ FLOW 1: new-user wallet auth ============
    const loginA = await login(app, WALLET_A, WALLET_A_PRIV);
    const loginB = await login(app, WALLET_B, WALLET_B_PRIV);
    ok("FLOW1: two wallet users created (distinct userIds)", loginA.userId !== loginB.userId);

    // /v1/auth/me returns the wallet.
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW1: /v1/auth/me resolves the wallet", me.statusCode === 200 && me.json()?.data?.wallet === WALLET_A, JSON.stringify(me.json()?.data));

    // Replay protection: a second verify on the same challenge fails.
    const ch = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet: WALLET_A } });
    const chBody = ch.json();
    const sig = await signMessage(WALLET_A_PRIV, chBody.data.message);
    const verify1 = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet/verify",
      payload: { challengeId: chBody.data.challengeId, wallet: WALLET_A, signature: sig, nonce: chBody.data.nonce }
    });
    ok("FLOW1: first verify succeeds", verify1.statusCode === 200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet/verify",
      payload: { challengeId: chBody.data.challengeId, wallet: WALLET_A, signature: sig, nonce: chBody.data.nonce }
    });
    ok("FLOW1: replay with the same challenge is rejected", replay.statusCode === 400 && (replay.json()?.error?.code ?? replay.json()?.code) === "CHALLENGE_CONSUMED", `${replay.statusCode}`);

    // Wrong-domain: tamper the trust-domain line in the signed message.
    const ch2 = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet: WALLET_A } });
    const ch2Body = ch2.json();
    const tampered = ch2Body.data.message.replace("Domain: http://localhost:3000", "Domain: https://evil.example");
    const sigBad = await signMessage(WALLET_A_PRIV, tampered);
    const wrongDomain = await app.inject({
      method: "POST",
      url: "/v1/auth/wallet/verify",
      payload: { challengeId: ch2Body.data.challengeId, wallet: WALLET_A, signature: sigBad, nonce: ch2Body.data.nonce }
    });
    ok("FLOW1: wrong-domain (tampered) message rejected", wrongDomain.statusCode === 401 || wrongDomain.statusCode === 400, `${wrongDomain.statusCode} ${wrongDomain.json()?.error?.code ?? wrongDomain.json()?.code}`);

    // ============ FLOW 2: anonymous public analysis admission ============
    // The eligible wallet has a fresh ready analysis + cache hit → accepted.
    const anon = await app.inject({ method: "POST", url: "/v1/analyses", payload: { address: WALLET_A } });
    const anonBody = anon.json();
    ok("FLOW2: anonymous analysis admission returns a valid (cached/202) response", [200, 202].includes(anon.statusCode), `${anon.statusCode}`);
    ok("FLOW2: anonymous analysis is safely gated (analysisId present, cached or created)", !!anonBody?.analysisId, JSON.stringify(anonBody));

    // Invalid wallet → 400.
    const invalid = await app.inject({ method: "POST", url: "/v1/analyses", payload: { address: "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" } });
    ok("FLOW2: invalid wallet returns 400", invalid.statusCode === 400);

    // Non-eligible account (a program/mint-like address) → ACCOUNT_NOT_ANALYZABLE.
    const nonEligible = await app.inject({ method: "POST", url: "/v1/analyses", payload: { address: NON_ELIGIBLE } });
    ok("FLOW2: non-eligible account returns ACCOUNT_NOT_ANALYZABLE", nonEligible.statusCode === 422 && nonEligible.json()?.code === "ACCOUNT_NOT_ANALYZABLE", `${nonEligible.statusCode} ${nonEligible.json()?.code}`);

    // ============ FLOW 3: wallet x-ray ============
    const xray = await app.inject({ method: "GET", url: `/v1/wallets/${WALLET_A}/x-ray` });
    const xrayBody = xray.json();
    ok("FLOW3: x-ray returns 200 for an analyzed wallet", xray.statusCode === 200);
    ok("FLOW3: x-ray exposure score present", xrayBody?.score !== null && typeof xrayBody?.score?.overall === "number", JSON.stringify(xrayBody?.score));
    ok("FLOW3: x-ray score and confidence are distinct", xrayBody?.score?.overall !== undefined && xrayBody?.score?.confidence !== undefined && xrayBody?.score?.overall !== xrayBody?.score?.confidence, `overall=${xrayBody?.score?.overall} conf=${xrayBody?.score?.confidence}`);
    ok("FLOW3: x-ray dimensions present (7)", Array.isArray(xrayBody?.dimensions) && (xrayBody.dimensions as unknown[]).length === 7, `${(xrayBody?.dimensions as unknown[])?.length}`);
    ok("FLOW3: x-ray topSignals present", Array.isArray(xrayBody?.topSignals) && (xrayBody.topSignals as unknown[]).length > 0, `${(xrayBody?.topSignals as unknown[])?.length}`);
    ok("FLOW3: x-ray attackPaths present", Array.isArray(xrayBody?.attackPaths) && (xrayBody.attackPaths as unknown[]).length > 0, `${(xrayBody?.attackPaths as unknown[])?.length}`);
    ok("FLOW3: x-ray engineVersions present", xrayBody?.engineVersions?.scoring === "score-v1.0.0", JSON.stringify(xrayBody?.engineVersions));
    const context = await app.inject({ method: "GET", url: `/v1/wallets/${WALLET_A}/context`, headers: { authorization: `Bearer ${loginA.token}` } });
    const contextBody = context.json();
    ok("D8: authenticated Context reuses persisted analysis", context.statusCode === 200 && contextBody.analysisId === xrayBody.analysis.id);
    ok("D8: seven existing dimensions preserved", contextBody.dimensions?.length === 7);
    ok("D8: every indicator has source and evidence references", contextBody.indicators?.every((i: { sourceEngine: string; engineVersion: string; evidenceRefs: string[] }) => i.sourceEngine && i.engineVersion && i.evidenceRefs?.length > 0));

    // ============ FLOW 4: compare ============
    const compare = await app.inject({ method: "POST", url: "/v1/compare", payload: { walletA: WALLET_A, walletB: WALLET_B } });
    const compareBody = compare.json();
    ok("FLOW4: compare returns 200", compare.statusCode === 200);
    ok("FLOW4: compare includes correlationScore + confidence", typeof compareBody?.correlation?.correlationScore === "number" && typeof compareBody?.correlation?.confidence === "number", JSON.stringify(compareBody?.correlation));
    ok("FLOW4: compare includes evidenceFamilies", Array.isArray(compareBody?.correlation?.evidenceFamilies) && (compareBody.correlation.evidenceFamilies as unknown[]).length > 0, `${(compareBody?.correlation?.evidenceFamilies as unknown[])?.length}`);
    ok("FLOW4: compare includes relationshipPaths", Array.isArray(compareBody?.relationshipPaths));
    ok("FLOW4: compare includes clusters", Array.isArray(compareBody?.clusters));
    ok("FLOW4: compare includes commonality (or fallback)", compareBody?.commonality !== undefined && typeof compareBody?.commonality?.source === "string", JSON.stringify(compareBody?.commonality));

    // Canonical pair symmetry: (A,B) == (B,A).
    const compareReverse = await app.inject({ method: "POST", url: "/v1/compare", payload: { walletA: WALLET_B, walletB: WALLET_A } });
    const reverseBody = compareReverse.json();
    ok("FLOW4: pairId is canonical — (B,A) returns the same pairId as (A,B)", reverseBody?.pairId === compareBody?.pairId, `${reverseBody?.pairId} vs ${compareBody?.pairId}`);

    // Self compare → DUPLICATE_WALLET / 400.
    const selfCompare = await app.inject({ method: "POST", url: "/v1/compare", payload: { walletA: WALLET_A, walletB: WALLET_A } });
    ok("FLOW4: self-compare returns DUPLICATE_WALLET or 400", selfCompare.statusCode === 400 && (selfCompare.json()?.code === "DUPLICATE_WALLET" || selfCompare.json()?.error?.code === "DUPLICATE_WALLET"), `${selfCompare.statusCode} ${selfCompare.json()?.code ?? selfCompare.json()?.error?.code}`);

    // ============ FLOW 5: save comparison (authenticated user A) ============
    const saved = await app.inject({
      method: "POST",
      url: "/v1/me/saved-comparisons",
      headers: { authorization: `Bearer ${loginA.token}` },
      payload: { walletA: WALLET_A, walletB: WALLET_B, label: "watch", notes: "private note" }
    });
    const savedBody = saved.json();
    ok("FLOW5: save comparison returns 201 + saved row", saved.statusCode === 201 && savedBody?.saved?.id !== undefined, `${saved.statusCode}`);
    const savedId = savedBody?.saved?.id;
    ok("FLOW5: saved comparison references the persisted result", savedBody?.saved?.comparison_result_id !== null, `${savedBody?.saved?.comparison_result_id}`);

    const listSaved = await app.inject({ method: "GET", url: "/v1/me/saved-comparisons", headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW5: GET /v1/me/saved-comparisons lists it", listSaved.statusCode === 200 && (listSaved.json()?.saved as unknown[])?.length === 1, `${(listSaved.json()?.saved as unknown[])?.length}`);

    const patchSaved = await app.inject({
      method: "PATCH",
      url: `/v1/me/saved-comparisons/${savedId}`,
      headers: { authorization: `Bearer ${loginA.token}` },
      payload: { label: "renamed", notes: "updated note" }
    });
    ok("FLOW5: PATCH updates label/notes", patchSaved.statusCode === 200 && patchSaved.json()?.saved?.label === "renamed" && patchSaved.json()?.saved?.notes === "updated note", JSON.stringify(patchSaved.json()?.saved));

    const savedDetail = await app.inject({ method: "GET", url: `/v1/me/saved-comparisons/${savedId}`, headers: { authorization: `Bearer ${loginA.token}` } });
    const savedDetailBody = savedDetail.json();
    ok("FLOW5: GET detail returns comparison + stale flag", savedDetail.statusCode === 200 && savedDetailBody?.comparison !== undefined && typeof savedDetailBody?.stale === "boolean", `comparison=${savedDetailBody?.comparison !== null} stale=${savedDetailBody?.stale}`);

    // Save the wallet so a monitor can be created on it.
    const saveWallet = await app.inject({ method: "POST", url: "/v1/me/saved", headers: { authorization: `Bearer ${loginA.token}` }, payload: { address: WALLET_A, label: "my wallet" } });
    ok("FLOW5: wallet saved (prerequisite for monitor)", saveWallet.statusCode === 201);

    // ============ FLOW 6: monitor + in-app notification ============
    const monitor = await app.inject({ method: "POST", url: "/v1/me/monitors", headers: { authorization: `Bearer ${loginA.token}` }, payload: { address: WALLET_A } });
    const monitorBody = monitor.json();
    ok("FLOW6: create monitor returns monitor + rules", monitor.statusCode === 201 && monitorBody?.monitor?.id !== undefined && monitorBody?.rules?.id !== undefined, `${monitor.statusCode}`);
    const monitorId = monitorBody?.monitor?.id;

    const monitorGet = await app.inject({ method: "GET", url: `/v1/me/monitors/${monitorId}`, headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW6: GET monitor returns monitor/events/checks", monitorGet.statusCode === 200 && monitorGet.json()?.monitor?.id !== undefined && Array.isArray(monitorGet.json()?.events) && Array.isArray(monitorGet.json()?.checks), `${monitorGet.statusCode}`);

    const monitorPatch = await app.inject({
      method: "PATCH",
      url: `/v1/me/monitors/${monitorId}`,
      headers: { authorization: `Bearer ${loginA.token}` },
      payload: { status: "PAUSED", alertRules: { minimumSeverity: "HIGH", cooldownHours: 12, notifyCorrelationChange: true } }
    });
    ok("FLOW6: PATCH pause + alertRules updates monitor", monitorPatch.statusCode === 200 && monitorPatch.json()?.monitor?.status === "PAUSED" && monitorPatch.json()?.rules?.cooldown_hours === 12, `status=${monitorPatch.json()?.monitor?.status} cooldown=${monitorPatch.json()?.rules?.cooldown_hours}`);

    // Seed an in-app notification for user A, then mark it read via the API.
    const notifRepo = createNotificationRepo(db);
    const notif = await notifRepo.insert({
      userId: loginA.userId,
      monitorId,
      eventId: null,
      channel: "IN_APP",
      type: "MONITOR_THREAT",
      title: "sample",
      body: "epistemic-safe body",
      severity: "HIGH",
      idempotencyKey: `d7-notif-${Date.now()}`,
      status: "PENDING"
    });
    ok("FLOW6: in-app notification seeded", notif?.id !== undefined);
    const readNotif = await app.inject({ method: "POST", url: `/v1/me/notifications/${notif!.id}/read`, headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW6: mark notification read", readNotif.statusCode === 200 && readNotif.json()?.read === true, `${readNotif.statusCode}`);

    // ============ FLOW 7: developer API ============
    const devKey = await app.inject({ method: "POST", url: "/v1/developer/keys", headers: { authorization: `Bearer ${loginA.token}` }, payload: { name: "d7 key", scopes: ["intelligence:read"] } });
    const devKeyBody = devKey.json();
    ok("FLOW7: create developer key returns a one-time key", devKey.statusCode === 201 && typeof devKeyBody?.key?.key === "string" && devKeyBody.key.key.startsWith("aegix_live_"), `${devKey.statusCode}`);
    const apiKey = devKeyBody?.key?.key;
    const devKeyId = devKeyBody?.key?.id;

    const devList = await app.inject({ method: "GET", url: "/v1/developer/keys", headers: { authorization: `Bearer ${loginA.token}` } });
    const devListBody = devList.json();
    ok("FLOW7: list keys (prefix only, no plaintext)", devList.statusCode === 200 && (devListBody?.keys as unknown[])?.length === 1 && devListBody.keys[0]?.key === undefined && typeof devListBody.keys[0]?.key_prefix === "string", `count=${(devListBody?.keys as unknown[])?.length}`);

    const devStatus = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${apiKey}` } });
    ok("FLOW7: developer status authenticates with the key", devStatus.statusCode === 200 && devStatus.json()?.data?.status === "ok", `${devStatus.statusCode}`);

    // Rotate: a NEW key is issued and the old one is immediately revoked.
    const devRotate = await app.inject({ method: "POST", url: `/v1/developer/keys/${devKeyId}/rotate`, headers: { authorization: `Bearer ${loginA.token}` } });
    const devRotateBody = devRotate.json();
    ok("FLOW7: rotate issues a new key (shown once)", devRotate.statusCode === 201 && typeof devRotateBody?.key?.key === "string" && devRotateBody.key.key !== apiKey, `${devRotate.statusCode}`);
    const newKey = devRotateBody?.key?.key;
    const newKeyId = devRotateBody?.key?.id;

    const oldStatus = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${apiKey}` } });
    ok("FLOW7: old key rejected after rotate", oldStatus.statusCode === 401 && (oldStatus.json()?.error?.code ?? oldStatus.json()?.code) === "REVOKED_API_KEY", `${oldStatus.statusCode}`);
    const newStatus = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${newKey}` } });
    ok("FLOW7: rotated key still works", newStatus.statusCode === 200 && newStatus.json()?.data?.status === "ok", `${newStatus.statusCode}`);

    // Revoke the rotated key (its id).
    const devRevoke = await app.inject({ method: "POST", url: `/v1/developer/keys/${newKeyId}/revoke`, headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW7: revoke returns the revoked key", devRevoke.statusCode === 200, `${devRevoke.statusCode}`);
    const revokedStatus = await app.inject({ method: "GET", url: "/v1/developer/status", headers: { authorization: `Bearer ${newKey}` } });
    ok("FLOW7: revoked key rejected on /status", revokedStatus.statusCode === 401 && (revokedStatus.json()?.error?.code ?? revokedStatus.json()?.code) === "REVOKED_API_KEY", `${revokedStatus.statusCode}`);

    // ============ FLOW 8: webhook management ============
    const webhook = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${loginA.token}` },
      payload: { url: "http://127.0.0.1:18765/hook", eventTypes: ["monitor.threat.created"] }
    });
    const webhookBody = webhook.json();
    ok("FLOW8: create webhook returns webhook + one-time secret", webhook.statusCode === 201 && webhookBody?.data?.webhook?.id !== undefined && typeof webhookBody?.data?.secret === "string" && webhookBody.data.secret.length > 0, `${webhook.statusCode}`);
    const webhookId = webhookBody?.data?.webhook?.id;
    const webhookSecret = webhookBody?.data?.secret;

    const webhookList = await app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW8: list webhooks", webhookList.statusCode === 200 && (webhookList.json()?.data as unknown[])?.length === 1, `${(webhookList.json()?.data as unknown[])?.length}`);

    const webhookTest = await app.inject({ method: "POST", url: `/v1/webhooks/${webhookId}/test`, headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW8: webhook test enqueues a delivery", webhookTest.statusCode === 200 && webhookTest.json()?.data?.queued === true, `${webhookTest.statusCode}`);

    const webhookRotate = await app.inject({ method: "POST", url: `/v1/webhooks/${webhookId}/rotate`, headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW8: rotate webhook secret (shown once)", webhookRotate.statusCode === 200 && typeof webhookRotate.json()?.data?.secret === "string" && webhookRotate.json()?.data?.secret !== webhookSecret, `${webhookRotate.statusCode}`);

    const webhookDisable = await app.inject({ method: "PATCH", url: `/v1/webhooks/${webhookId}`, headers: { authorization: `Bearer ${loginA.token}` }, payload: { status: "DISABLED" } });
    ok("FLOW8: disable webhook", webhookDisable.statusCode === 200 && webhookDisable.json()?.data?.status === "DISABLED", `${webhookDisable.statusCode} ${webhookDisable.json()?.data?.status}`);
    const webhookEnable = await app.inject({ method: "PATCH", url: `/v1/webhooks/${webhookId}`, headers: { authorization: `Bearer ${loginA.token}` }, payload: { status: "ACTIVE" } });
    ok("FLOW8: re-enable webhook", webhookEnable.statusCode === 200 && webhookEnable.json()?.data?.status === "ACTIVE", `${webhookEnable.statusCode} ${webhookEnable.json()?.data?.status}`);

    // Consumer signature verification via verifyWebhookRequest: a valid
    // signature passes, a tampered body fails.
    const whPayload = JSON.stringify({ id: "evt-d7", type: "monitor.threat.created", createdAt: new Date().toISOString(), data: { test: true } });
    const whTimestamp = Math.floor(Date.now() / 1000).toString();
    const whSig = signWebhookPayload(webhookSecret, whTimestamp, whPayload);
    ok("FLOW8: verifyWebhookRequest accepts a valid signature", verifyWebhookRequest({ rawBody: whPayload, signature: whSig, timestamp: whTimestamp, secret: webhookSecret }).valid === true);
    ok("FLOW8: verifyWebhookRequest rejects a tampered body", verifyWebhookRequest({ rawBody: whPayload + "x", signature: whSig, timestamp: whTimestamp, secret: webhookSecret }).valid === false);

    // SSRF: a production policy (devPrivate=false, default ports) must block
    // private destinations. The dev-private policy is NOT a silent production
    // fallback — it explicitly gates local delivery.
    const prodPolicy = { ...config, WEBHOOK_DEV_ALLOW_PRIVATE: false, WEBHOOK_ALLOWED_PORTS: "80,443" };
    for (const target of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:18765/hook"]) {
      await resolveWebhookDestination(target, prodPolicy).then(
        () => ok(`FLOW8: SSRF blocked (${target})`, false),
        (err) => ok(`FLOW8: SSRF blocked (${target})`, err instanceof SsrfBlockedError)
      );
    }
    const devDest = await resolveWebhookDestination("http://127.0.0.1:18765/hook", config);
    ok("FLOW8: dev-private policy gates local delivery (test only)", devDest.ip === "127.0.0.1");

    const webhookDelete = await app.inject({ method: "DELETE", url: `/v1/webhooks/${webhookId}`, headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW8: delete webhook", webhookDelete.statusCode === 200 && webhookDelete.json()?.data?.deleted === true, `${webhookDelete.statusCode}`);

    // ============ FLOW 9: cross-user isolation ============
    const bSaved = await app.inject({ method: "GET", url: "/v1/me/saved-comparisons", headers: { authorization: `Bearer ${loginB.token}` } });
    ok("FLOW9: user B does NOT see user A's saved comparison", (bSaved.json()?.saved as unknown[])?.length === 0, `${(bSaved.json()?.saved as unknown[])?.length}`);

    const bSavedDetail = await app.inject({ method: "GET", url: `/v1/me/saved-comparisons/${savedId}`, headers: { authorization: `Bearer ${loginB.token}` } });
    ok("FLOW9: user B cannot read user A's saved-comparison detail", bSavedDetail.statusCode === 404, `${bSavedDetail.statusCode}`);

    const bSavedAnalyses = await app.inject({ method: "GET", url: "/v1/me/saved", headers: { authorization: `Bearer ${loginB.token}` } });
    ok("FLOW9: user B does NOT see user A's saved analysis", (bSavedAnalyses.json()?.saved as unknown[])?.length === 0, `${(bSavedAnalyses.json()?.saved as unknown[])?.length}`);

    const bMonitors = await app.inject({ method: "GET", url: "/v1/me/monitors", headers: { authorization: `Bearer ${loginB.token}` } });
    ok("FLOW9: user B does NOT see user A's monitors", (bMonitors.json()?.monitors as unknown[])?.length === 0, `${(bMonitors.json()?.monitors as unknown[])?.length}`);

    const bWebhooks = await app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization: `Bearer ${loginB.token}` } });
    ok("FLOW9: user B does NOT see user A's webhooks", (bWebhooks.json()?.data as unknown[])?.length === 0, `${(bWebhooks.json()?.data as unknown[])?.length}`);

    // ============ FLOW 10: returning user ============
    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${loginA.token}` } });
    ok("FLOW10: logout revokes the session", logout.statusCode === 200 && logout.json()?.data?.revoked === true, `${logout.statusCode}`);

    const reloginA = await login(app, WALLET_A, WALLET_A_PRIV);
    ok("FLOW10: re-login returns the same userId", reloginA.userId === loginA.userId, `${reloginA.userId} vs ${loginA.userId}`);

    const reloginSaved = await app.inject({ method: "GET", url: "/v1/me/saved-comparisons", headers: { authorization: `Bearer ${reloginA.token}` } });
    ok("FLOW10: saved data persists across logout/login", (reloginSaved.json()?.saved as unknown[])?.length === 1, `${(reloginSaved.json()?.saved as unknown[])?.length}`);
  } finally {
    await app.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("D7 E2E crashed:", err);
  process.exit(1);
});
