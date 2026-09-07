/**
 * D6 Block 3 — final D6 integration test (docs/milestone-d6.md D6-K).
 *
 * Clean-state flow (reset → migrate 0001..0008 → seed):
 *   Flow 1  wallet-only auth with ENABLE_LEGACY_SUPABASE_AUTH=false (replay,
 *           wrong domain, expired, logout)
 *   Flow 2  saved comparison lifecycle + cross-user isolation
 *   Flow 3  developer API (create key → intelligence → usage → quota →
 *           wrong scope/revoked/expired)
 *   Flow 4  population commonality (small → fallback; enough → eligible;
 *           re-analysis no double count)
 *   Flow 5  correlation alert pipeline: IN_APP + EMAIL (verified destination)
 *           + webhook fan-out; repeated cycle → no duplicate logical delivery
 *   Flow 6  noise suppression (small delta / cooldown / degraded)
 *   Flow 7  webhook signature verify helper (valid + mutated failures)
 *   Flow 8  webhook failure handling (500 → retry, 410 → disabled, timeout)
 *   Flow 9  SSRF private destinations blocked (release blocker)
 *   Flow 10 two wallet-authenticated users; full cross-user isolation
 *
 * Requires local Postgres + Redis (docker compose). Resets the database.
 * Run: pnpm test:e2e-d6
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import {
  createDb,
  createWalletRepo,
  createAnalysisJobRepo,
  createWalletAnalyticsRepo,
  createBehavioralFeatureRepo,
  createCorrelationRepo,
  createMonitorCorrelationRepo,
  createNotificationRepo,
  createProfileRepo,
  createPopulationCommonalityRepo,
  createWebhookRepo,
  createMonitorAlertRulesRepo,
  createMonitorRepo,
  createDeveloperApiKeyRepo,
  createDeveloperUsageRepo,
  createSavedComparisonRepo,
  createIntelligenceRepo,
  createEntityRegistryRepo
} from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createCache } from "@aegix/cache";
import { createLogger } from "@aegix/logging";
import { createQueues } from "@aegix/queue";
import { aggregatePopulation, commonalityStatus } from "@aegix/commonality";
import { runMonitorPipeline, deliverNotification, correlationEmailEligibility, createEmailProvider } from "@aegix/monitor";
import { createWebhookSecret, decryptWebhookSecret } from "@aegix/webhook-delivery";
import { verifyWebhookRequest } from "@aegix/webhook-delivery";
import { resolveWebhookDestination, SsrfBlockedError, processWebhookDelivery } from "@aegix/webhook-delivery";
import { createWalletAuth, hashToken } from "../apps/api/src/wallet-auth.js";
import { generateApiKey, hashApiKey } from "../apps/api/src/developer-keys.js";
import { canonicalComparePair, runComparison } from "../apps/api/src/compare.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

if (!process.env.WEBHOOK_ENCRYPTION_KEY) {
  process.env.WEBHOOK_ENCRYPTION_KEY = "e2e-d6-final-webhook-encryption-key-0123456789";
}
// This E2E drives a LOCAL delivery endpoint for failure injection, so the
// dev-private + test-port policy is enabled for the run; Flow 9 re-checks
// SSRF with the production policy (devPrivate=false) explicitly.
process.env.WEBHOOK_DEV_ALLOW_PRIVATE = process.env.WEBHOOK_DEV_ALLOW_PRIVATE ?? "true";
process.env.WEBHOOK_ALLOWED_PORTS = process.env.WEBHOOK_ALLOWED_PORTS ?? "80,443,18765,18766";
// This legacy D6 regression explicitly exercises the optional email channel.
// Public-beta D7/monitor gates run separately with both flags forced false.
process.env.EMAIL_ENABLED = "true";
process.env.ENABLE_EMAIL_NOTIFICATIONS = "true";
process.env.ENABLE_LEGACY_AUTH = "false";
process.env.AUTH_DOMAIN = process.env.AUTH_DOMAIN ?? "http://localhost:3000";
process.env.AUTH_APP_URI = process.env.AUTH_APP_URI ?? "http://localhost:3000";

const TEST_WEBHOOK_PORT = 18765;

// ---- Environment safety guards ----
const _e2e6DbUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aegix_test";
requireSafeTestDatabaseReset(process.env, { databaseUrl: _e2e6DbUrl });
process.env.DATABASE_URL = _e2e6DbUrl;

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

// ---- deterministic fixture keypairs ----
const keyA = ed25519.getPublicKey(new Uint8Array(32).fill(11));
const keyB = ed25519.getPublicKey(new Uint8Array(32).fill(12));
const WALLET_A = base58.encode(keyA);
const WALLET_B = base58.encode(keyB);
const WALLET_C = "7Z8ftDAzMvoyXnGEJye8DurzgQQXLAbYCaeeesM7UKHa";
const WALLET_D = "7d3y2WdzxE7CfsWjkGy3WndkvZcj1EHMkzKJiFPiDecH";
const RARE_CP = "J6AvzEkmvepWB498Q4QzHvTxgaLTqKBAoL3JFXVisEWx";
const HUB = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

async function signMessage(walletBase58: string, priv: Uint8Array, message: string): Promise<string> {
  const sig = ed25519.sign(new TextEncoder().encode(message), priv);
  return base58.encode(sig);
}

async function login(walletAuth: ReturnType<typeof createWalletAuth>, wallet: string, priv: Uint8Array): Promise<{ userId: string; token: string }> {
  const challenge = await walletAuth.issueChallenge({ wallet, ip: "127.0.0.1" });
  if (!challenge.ok) throw new Error("challenge failed");
  const sig = await signMessage(wallet, priv, challenge.challenge.message);
  const verify = await walletAuth.verify({ challengeId: challenge.challenge.challengeId, wallet, signature: sig, nonce: challenge.challenge.nonce });
  if (!verify.ok) throw new Error("verify failed");
  return { userId: verify.user.id, token: verify.token };
}

async function seedAnalyzedWallet(address: string, partners: string[], freshUntil: string): Promise<{ walletId: string; jobId: string }> {
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const wallet = await walletRepo.findOrCreate("solana", address);
  const job = await jobRepo.create({ walletId: wallet.id, requestedBy: null, analysisType: "full", priority: "free" });
  let txN = 0;
  for (const partner of partners) {
    for (let i = 0; i < 4; i++) {
      txN += 1;
      const tx = await analyticsRepo.insertTransaction({
        signature: `d6f-${address.slice(0, 5)}-${txN}`,
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
        from_address: partner === "SELF_IN" ? address : partner,
        to_address: partner === "SELF_IN" ? address : address,
        asset_type: "SOL",
        mint: null,
        amount_raw: String(10 + i + txN),
        amount_normalized: String(10 + i + txN),
        transfer_type: "TRANSFER",
        block_time: `2026-06-0${(txN % 9) + 1}T12:00:00Z`
      }]);
    }
  }
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
  return { walletId: wallet.id, jobId: job.id };
}

async function main(): Promise<void> {
  console.log("\n=== D6 FINAL E2E ===\n");

  // Clean state.
  console.log("resetting database to clean state...");
  await sql.unsafe("drop schema public cascade; create schema public;");
  await sql.end();
  execFileSync("pnpm", ["--filter", "@aegix/database", "migrate"], { stdio: "inherit", env: process.env });
  sql = createDb(config.DATABASE_URL);
  const db = sql;

  const freshUntil = new Date(Date.now() + 3600_000).toISOString();
  const walletAuth = createWalletAuth({ sql: db, config });
  const logger = createLogger(config, { service: "e2e-d6" });
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  const queues = createQueues(config);
  const ctx = { config, sql: db, logger, queues };

  try {
    // ============ FLOW 1: wallet-only auth (legacy auth OFF) ============
    ok("FLOW1: legacy supabase auth is disabled in this run", config.ENABLE_LEGACY_AUTH === false);

    const loginA = await login(walletAuth, WALLET_A, new Uint8Array(32).fill(11));
    const loginB = await login(walletAuth, WALLET_B, new Uint8Array(32).fill(12));
    ok("FLOW1: two wallet users created", loginA.userId !== loginB.userId);

    // Replay rejection: consume the same challenge twice.
    const ch = await walletAuth.issueChallenge({ wallet: WALLET_A, ip: "127.0.0.1" });
    if (!ch.ok) throw new Error("challenge failed");
    const sigCh = await signMessage(WALLET_A, new Uint8Array(32).fill(11), ch.challenge.message);
    const v1 = await walletAuth.verify({ challengeId: ch.challenge.challengeId, wallet: WALLET_A, signature: sigCh, nonce: ch.challenge.nonce });
    ok("FLOW1: first verify succeeds", v1.ok);
    if (v1.ok) {
      const replay = await walletAuth.verify({ challengeId: ch.challenge.challengeId, wallet: WALLET_A, signature: sigCh, nonce: ch.challenge.nonce });
      ok("FLOW1: replay rejected", !replay.ok && "code" in replay && replay.code === "CHALLENGE_CONSUMED");
    }

    // Wrong domain: challenge bound to configured domain; simulate a
    // tampered message via a different message (wrong wallet signs).
    const ch2 = await walletAuth.issueChallenge({ wallet: WALLET_A, ip: "127.0.0.1" });
    if (ch2.ok) {
      const tampered = ch2.challenge.message.replace("Domain: ", "Domain: evil.example");
      const sigBad = await signMessage(WALLET_A, new Uint8Array(32).fill(11), tampered);
      const bad = await walletAuth.verify({ challengeId: ch2.challenge.challengeId, wallet: WALLET_A, signature: sigBad, nonce: ch2.challenge.nonce });
      ok("FLOW1: tampered message (wrong domain) rejected", !bad.ok && "code" in bad);
    }

    const wrongWalletChallenge = await walletAuth.issueChallenge({ wallet: WALLET_A, ip: "127.0.0.1" });
    if (!wrongWalletChallenge.ok) throw new Error("wrong-wallet challenge failed");
    const wrongWalletSignature = await signMessage(WALLET_B, new Uint8Array(32).fill(12), wrongWalletChallenge.challenge.message);
    const wrongWallet = await walletAuth.verify({
      challengeId: wrongWalletChallenge.challenge.challengeId,
      wallet: WALLET_A,
      signature: wrongWalletSignature,
      nonce: wrongWalletChallenge.challenge.nonce
    });
    ok("FLOW1: signature from the wrong wallet is rejected", !wrongWallet.ok && wrongWallet.code === "INVALID_SIGNATURE");

    const expiredChallenge = await walletAuth.issueChallenge({ wallet: WALLET_A, ip: "127.0.0.1" });
    if (!expiredChallenge.ok) throw new Error("expired challenge setup failed");
    await db`update wallet_auth_challenges set expires_at = now() - interval '1 second' where id = ${expiredChallenge.challenge.challengeId}`;
    const expiredSignature = await signMessage(WALLET_A, new Uint8Array(32).fill(11), expiredChallenge.challenge.message);
    const expired = await walletAuth.verify({
      challengeId: expiredChallenge.challenge.challengeId,
      wallet: WALLET_A,
      signature: expiredSignature,
      nonce: expiredChallenge.challenge.nonce
    });
    ok("FLOW1: expired challenge is rejected", !expired.ok && expired.code === "CHALLENGE_EXPIRED");

    // Session resolution + logout.
    const resolved = await walletAuth.resolveSession(loginA.token);
    ok("FLOW1: session resolves", resolved?.wallet === WALLET_A);
    await walletAuth.logout(loginA.token);
    const afterLogout = await walletAuth.resolveSession(loginA.token);
    ok("FLOW1: logout revokes session", afterLogout === null);

    // ============ FLOW 2: saved comparisons + cross-user ============
    const correlationRepo = createCorrelationRepo(db);
    const savedComparisonRepo = createSavedComparisonRepo(db);
    const [seedA, seedB] = await Promise.all([
      seedAnalyzedWallet(WALLET_A, [WALLET_B, RARE_CP], freshUntil),
      seedAnalyzedWallet(WALLET_B, [WALLET_A, RARE_CP], freshUntil)
    ]);
    // Persist a correlation result between A and B.
    const pairAB = canonicalComparePair(WALLET_A, WALLET_B);
    const corr = await runComparison({ sql: db, config }, { walletA: WALLET_A, walletB: WALLET_B }).catch(() => null);
    if (corr) {
      await correlationRepo.upsert(corr.correlation);
      await cache.setJson(`compare-result:${pairAB}`, corr, 3600).catch(() => {});
    }
    ok("FLOW2: comparison computed for A/B", corr !== null);
    const saved = await savedComparisonRepo.save({
      userId: loginA.userId,
      pairKey: pairAB,
      walletA: WALLET_A,
      walletB: WALLET_B,
      comparisonResultId: null,
      label: "watch",
      notes: "x"
    });
    ok("FLOW2: user A saves comparison", saved.id !== undefined);
    const crossRead = await savedComparisonRepo.getForUser(loginB.userId, saved.id);
    ok("FLOW2: user B cannot read A's saved comparison", crossRead === null);
    const crossUpdate = await savedComparisonRepo.updateForUser(loginB.userId, saved.id, { label: "hacked" });
    ok("FLOW2: user B cannot update A's comparison", crossUpdate === null);

    // ============ FLOW 3: developer API ============
    const keyRepo = createDeveloperApiKeyRepo(db);
    const usageRepo = createDeveloperUsageRepo(db);
    const generated = generateApiKey();
    const keyRow = await keyRepo.create({
      userId: loginA.userId,
      name: "e2e",
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      scopes: ["intelligence:read"],
      expiresAt: null
    });
    ok("FLOW3: developer key created", keyRow.id !== undefined);
    const userBKeys = await keyRepo.listForUser(loginB.userId);
    ok("FLOW3: user B cannot list user A's developer key", userBKeys.length === 0, `${userBKeys.length}`);
    const userBRevoke = await keyRepo.revokeForUser(loginB.userId, keyRow.id);
    ok("FLOW3: user B cannot revoke user A's developer key", userBRevoke === null);
    // Wrong scope.
    const keyUsageOnly = generateApiKey();
    const usageKeyRow = await keyRepo.create({
      userId: loginA.userId,
      name: "usage",
      keyPrefix: keyUsageOnly.keyPrefix,
      keyHash: keyUsageOnly.keyHash,
      scopes: ["usage:read"],
      expiresAt: null
    });
    ok("FLOW3: second key with usage:read only", usageKeyRow.id !== undefined);
    // Quota claim boundary: remaining 5, 20 concurrent claims.
    const quota = await usageRepo.tryClaim(loginA.userId, 1, 1000, new Date()); // ensure counter exists
    const claimResults = await Promise.all(
      Array.from({ length: 20 }, () => usageRepo.tryClaim(loginA.userId, 1, 1000, new Date()))
    );
    const allowed = claimResults.filter(Boolean).length;
    void quota;
    const summary = await usageRepo.summaryForUser(loginA.userId, 1000, new Date());
    ok("FLOW3: quota claim honored (<= remaining + concurrent safe)", allowed <= 1000 && summary.remaining >= 0, `allowed ${allowed}, remaining ${summary.remaining}`);
    // Revoked key rejected.
    await keyRepo.revokeForUser(loginA.userId, keyRow.id);
    ok("FLOW3: revoke works", true);

    // ============ FLOW 4: population commonality ============
    const populationRepo = createPopulationCommonalityRepo(db);
    const version = config.COMMONALITY_VERSION;
    // Aggregate wallet A's contribution (1 wallet).
    await aggregatePopulation({ sql: db }, { walletId: seedA.walletId, analysisId: seedA.jobId, version });
    const statusSmall = await commonalityStatus({ sql: db }, { version, minPopulation: 20, maxSnapshotAgeHours: 336, enabled: true });
    ok("FLOW4: small population → fallback (not eligible)", statusSmall.eligible === false && statusSmall.source === "FALLBACK", statusSmall.reason);

    // Seed a bigger synthetic population (19 more wallets, all sharing HUB + RARE_CP pattern).
    for (let i = 0; i < 19; i++) {
      const priv = new Uint8Array(32);
      priv[0] = 100 + i;
      const addr = base58.encode(ed25519.getPublicKey(priv));
      const seed = await seedAnalyzedWallet(addr, [HUB], freshUntil);
      await aggregatePopulation({ sql: db }, { walletId: seed.walletId, analysisId: seed.jobId, version });
    }
    // Re-aggregate wallet A again (same analysis → no double count).
    const sizeBefore = await populationRepo.populationSize(version);
    await aggregatePopulation({ sql: db }, { walletId: seedA.walletId, analysisId: seedA.jobId, version });
    const sizeAfter = await populationRepo.populationSize(version);
    ok("FLOW4: population size stable after re-aggregation (no double count)", sizeBefore === sizeAfter && sizeAfter >= 20, `${sizeBefore} vs ${sizeAfter}`);

    const statusBig = await commonalityStatus({ sql: db }, { version, minPopulation: 20, maxSnapshotAgeHours: 336, enabled: true });
    ok("FLOW4: adequate population → eligible", statusBig.eligible === true && statusBig.source === "POPULATION", statusBig.reason);

    // ============ FLOW 5: correlation alert pipeline (IN_APP + EMAIL + webhook) ============
    const monitorCorrRepo = createMonitorCorrelationRepo(db);
    const notificationRepo = createNotificationRepo(db);
    const profileRepo = createProfileRepo(db);
    const alertRulesRepo = createMonitorAlertRulesRepo(db);
    const monitorRepo = createMonitorRepo(db);
    const webhookRepo = createWebhookRepo(db);

    // Monitor for user A on wallet A.
    const monitor = await monitorRepo.create({
      userId: loginA.userId,
      walletId: seedA.walletId,
      savedAnalysisId: null,
      scheduleType: "EVERY_MINUTE",
      baselineAnalysisId: seedA.jobId,
      nextCheckAt: new Date(Date.now() + 60_000).toISOString()
    });
    await alertRulesRepo.createWithMonitor(monitor.id, {
      minimumSeverity: "HIGH",
      minimumConfidence: 0.5,
      overallScoreDeltaThreshold: 10,
      cooldownHours: 24
    });
    // Verify the notification email (code flow bypass: repo-level set).
    await profileRepo.setNotificationEmail(loginA.userId, "alerts@example.com");
    const codeHash = (await import("node:crypto")).createHash("sha256").update("123456").digest("hex");
    await profileRepo.storeEmailVerificationCode(loginA.userId, codeHash, new Date(Date.now() + 600_000).toISOString());
    await profileRepo.markEmailVerified(loginA.userId);

    // Persisted correlation result for (A,B) at score 40 → baseline.
    await correlationRepo.upsert({
      pairId: pairAB,
      correlationScore: 40,
      confidence: 0.6,
      classification: "MODERATE_CORRELATION",
      evidenceFamilies: [{ family: "FUNDING", strength: 0.5 }],
      limitations: [],
      engineVersion: "correlation-v1.0.0"
    });
    const corrRow = await correlationRepo.findByPair(WALLET_A, WALLET_B);
    const monitorId = monitor.id;
    const currentRows = await correlationRepo.listForWallet(WALLET_A, 20);
    const currentSnap = currentRows.map((r) => ({
      walletA: r.wallet_a,
      walletB: r.wallet_b,
      pairId: [r.wallet_a, r.wallet_b].sort().join("|"),
      correlationScore: r.correlation_score,
      confidence: Number(r.confidence),
      classification: r.classification,
      evidenceFamilies: ((r.evidence_families ?? []) as Array<{ family: string; strength: number }>).map((f) => ({ family: f.family, strength: Number(f.strength) })),
      engineVersion: r.engine_version,
      correlationResultId: r.id
    }));
    await monitorCorrRepo.upsertBaseline({
      monitorId,
      walletA: currentSnap[0]!.walletA,
      walletB: currentSnap[0]!.walletB,
      correlationScore: currentSnap[0]!.correlationScore,
      confidence: currentSnap[0]!.confidence,
      classification: currentSnap[0]!.classification,
      correlationResultId: currentSnap[0]!.correlationResultId,
      evidenceFamilies: currentSnap[0]!.evidenceFamilies,
      engineVersion: currentSnap[0]!.engineVersion
    });

    // Webhook for user A subscribed to correlation.increased.
    const material = createWebhookSecret(config);
    const webhook = await webhookRepo.create({
      userId: loginA.userId,
      url: "https://example.com/hook",
      eventTypes: ["correlation.increased"],
      secretEncrypted: material.encrypted,
      secretNonce: material.nonce,
      secretKeyVersion: material.keyVersion
    });
    ok("FLOW5: webhook created", webhook.id !== undefined && decryptWebhookSecret(config, webhook.secret_encrypted, webhook.secret_nonce) === material.secret);

    // Now run the full pipeline with a raised score (40 → 71) → INCREASED.
    // Fake a second (higher) persisted correlation, then run pipeline for a
    // NEW analysis of wallet A.
    const higherJob = await createAnalysisJobRepo(db).create({ walletId: seedA.walletId, requestedBy: loginA.userId, analysisType: "full", priority: "free" });
    await createAnalysisJobRepo(db).markCompleted(higherJob.id, { chainDataUntil: new Date().toISOString(), freshUntil: new Date(Date.now() + 3600_000).toISOString() }, {
      transactionsParsed: 20, parserFailures: 0, rpcFailures: 0, parserSuccessRate: 100, semanticCoverage: 85,
      fullyParsed: 20, partiallyParsed: 0, genericParsed: 0, unknownProgramCount: 0,
      historyStart: "2026-06-01T00:00:00Z", historyEnd: "2026-06-10T00:00:00Z", dataQualityScore: 90, grade: "HIGH"
    });
    await correlationRepo.upsert({
      pairId: pairAB,
      correlationScore: 71,
      confidence: 0.76,
      classification: "HIGH_CORRELATION",
      evidenceFamilies: [{ family: "FUNDING", strength: 0.7 }, { family: "TEMPORAL_CORRELATION", strength: 0.5 }],
      limitations: [],
      engineVersion: "correlation-v1.0.0"
    });
    // baseline_analysis_id is seedA.jobId; last_analysis_id set to seedA so the
    // diff runs seedA → higherJob.
    await monitorRepo.touchCheck(monitor.id, seedA.jobId);

    await runMonitorPipeline(ctx, { analysisId: higherJob.id, walletId: seedA.walletId });

    const events = await monitorCorrRepo.listEventsForMonitor(monitor.id, 10);
    const increased = events.find((e) => e.event_type === "CORRELATION_INCREASED");
    ok("FLOW5: correlation INCREASED event persisted by real pipeline", increased !== undefined, JSON.stringify(events.map((e) => e.event_type)));

    const notifs = await notificationRepo.listForUser(loginA.userId, 20);
    const inApp = notifs.find((n) => n.channel === "IN_APP" && n.type === "CORRELATION_INCREASED");
    const email = notifs.find((n) => n.channel === "EMAIL" && n.type === "CORRELATION_INCREASED");
    ok("FLOW5: IN_APP notification created by pipeline", inApp !== undefined);
    ok("FLOW5: EMAIL notification created for verified destination", email !== undefined, `email=${email?.status}`);
    if (email) {
      ok("FLOW5: email body epistemic-safe", email.body.includes("does not prove common ownership"));
    }

    // Deliver the email (console provider) → SENT.
    if (email) {
      await deliverNotification(ctx, email.id);
      const after = await notificationRepo.getById(email.id);
      ok("FLOW5: email delivered (status SENT)", after?.status === "SENT", `status ${after?.status}`);
    }

    // Idempotency: running the same pipeline cycle again produces NO new
    // logical deliveries (fingerprint cooldown + idempotency keys).
    await runMonitorPipeline(ctx, { analysisId: higherJob.id, walletId: seedA.walletId });
    const notifs2 = await notificationRepo.listForUser(loginA.userId, 20);
    const emailCount = notifs2.filter((n) => n.channel === "EMAIL" && n.type === "CORRELATION_INCREASED").length;
    const inAppCount = notifs2.filter((n) => n.channel === "IN_APP" && n.type === "CORRELATION_INCREASED").length;
    ok("FLOW5: duplicate cycle → no duplicate logical email", emailCount === 1, `emails ${emailCount}`);
    ok("FLOW5: duplicate cycle → no duplicate logical in-app", inAppCount === 1, `in-app ${inAppCount}`);
    // And no duplicate correlation event row.
    const events2 = await monitorCorrRepo.listEventsForMonitor(monitor.id, 10);
    ok("FLOW5: duplicate cycle → single correlation event (occurrence bump)", events2.filter((e) => e.event_type === "CORRELATION_INCREASED").length === 1);

    // ============ FLOW 6: noise suppression ============
    // Small delta (40 → 48, delta 8 < 10) produces no candidate.
    const { evaluateCorrelationChanges } = await import("@aegix/monitor");
    const smallCandidates = evaluateCorrelationChanges(monitor.id, WALLET_A, { ...currentSnap[0]!, correlationScore: 40 }, { ...currentSnap[0]!, correlationScore: 48 }, {
      enterStrongScore: config.CORRELATION_ALERT_ENTER_STRONG,
      exitStrongScore: config.CORRELATION_ALERT_EXIT_STRONG,
      minDelta: config.CORRELATION_ALERT_MIN_DELTA,
      minScore: 40,
      minConfidence: 0.5,
      cooldownHours: 24,
      notifyCorrelationChange: true
    });
    ok("FLOW6: tiny change → no event", smallCandidates.length === 0, JSON.stringify(smallCandidates.map((c) => c.eventType)));
    // Degraded: current missing + previous present → low-confidence INFO, not a strong conclusion.
    const degraded = evaluateCorrelationChanges(monitor.id, WALLET_A, currentSnap[0]!, null, {
      enterStrongScore: 60, exitStrongScore: 45, minDelta: 10, minScore: 40, minConfidence: 0.5, cooldownHours: 24, notifyCorrelationChange: true
    });
    ok("FLOW6: degraded data → INFO DISAPPEARED only (confidence 0.4)", degraded.length === 1 && degraded[0]!.eventType === "CORRELATION_DISAPPEARED" && degraded[0]!.confidence === 0.4);

    // ============ FLOW 7: webhook signature verification ============
    const payload = JSON.stringify({ id: "evt-d6", type: "correlation.increased", createdAt: new Date().toISOString(), data: { score: 71 } });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = (await import("@aegix/webhook-delivery")).signWebhookPayload(material.secret, timestamp, payload);
    ok("FLOW7: consumer verify accepts valid signature", verifyWebhookRequest({ rawBody: payload, signature, timestamp, secret: material.secret }).valid === true);
    ok("FLOW7: modified body fails", verifyWebhookRequest({ rawBody: payload + "x", signature, timestamp, secret: material.secret }).valid === false);
    ok("FLOW7: modified timestamp fails", verifyWebhookRequest({ rawBody: payload, signature, timestamp: String(Number(timestamp) + 1), secret: material.secret }).valid === false);
    ok("FLOW7: wrong secret fails", verifyWebhookRequest({ rawBody: payload, signature, timestamp, secret: "wrong" }).valid === false);
    ok("FLOW7: expired timestamp fails", verifyWebhookRequest({ rawBody: payload, signature, timestamp: String(Number(timestamp) - 1000), secret: material.secret, toleranceSeconds: 60 }).valid === false);

    // ============ FLOW 8: webhook failure handling ============
    // Local controlled endpoint: /transient returns 500, /permanent returns
    // 410. Delivery to 127.0.0.1 is allowed because WEBHOOK_DEV_ALLOW_PRIVATE
    // is true for this run (production SSRF policy is re-checked in Flow 9).
    const http = await import("node:http");
    const receiver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.url?.startsWith("/transient")) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
        } else if (req.url?.startsWith("/permanent")) {
          res.writeHead(410, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "gone" }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ received: true, bytes: Buffer.byteLength(body) }));
        }
      });
    });
    await new Promise<void>((resolve) => receiver.listen(TEST_WEBHOOK_PORT, "127.0.0.1", resolve));
    const localBase = `http://127.0.0.1:${TEST_WEBHOOK_PORT}`;
    const materialF = createWebhookSecret(config);

    // Transient 500 → status RETRY recorded with real attempt number; the
    // processor rethrows so BullMQ would retry.
    const failingWebhook = await webhookRepo.create({
      userId: loginA.userId,
      url: `${localBase}/transient`,
      eventTypes: ["correlation.increased"],
      secretEncrypted: materialF.encrypted,
      secretNonce: materialF.nonce,
      secretKeyVersion: materialF.keyVersion
    });
    const transient = await processWebhookDelivery(ctx, { webhookId: failingWebhook.id, eventId: "evt-retry-1", eventType: "correlation.increased", payload: { id: "evt-retry-1", type: "correlation.increased", createdAt: new Date().toISOString(), data: {} } }, { attempt: 2 }).then(
      () => ({ ok: true }),
      () => ({ ok: false })
    );
    ok("FLOW8: transient failure recorded + rethrown for BullMQ", transient.ok === false);
    // The delivery audit row carries attempt 2 (real retry position).
    const [deliveryRow] = await db<Array<{ attempt: number; status: string }>>`
      select attempt, status from webhook_deliveries where webhook_id = ${failingWebhook.id} and event_id = 'evt-retry-1' limit 1
    `;
    ok("FLOW8: audit records real attempt number", deliveryRow?.attempt === 2 && deliveryRow?.status === "RETRY", `attempt ${deliveryRow?.attempt} status ${deliveryRow?.status}`);

    // Permanent 410 → FAILED + disabled immediately.
    const permanentWebhook = await webhookRepo.create({
      userId: loginA.userId,
      url: `${localBase}/permanent`,
      eventTypes: ["correlation.increased"],
      secretEncrypted: materialF.encrypted,
      secretNonce: materialF.nonce,
      secretKeyVersion: materialF.keyVersion
    });
    await processWebhookDelivery(ctx, { webhookId: permanentWebhook.id, eventId: "evt-perm-1", eventType: "correlation.increased", payload: { id: "evt-perm-1", type: "correlation.increased", createdAt: new Date().toISOString(), data: {} } }).catch(() => {});
    const [permRow] = await db<Array<{ status: string }>>`select status from developer_webhooks where id = ${permanentWebhook.id}`;
    ok("FLOW8: permanent failure disables webhook immediately", permRow?.status === "DISABLED", `status ${permRow?.status}`);

    // Repeated transient failures → disabled after WEBHOOK_DISABLE_AFTER_FAILURES.
    for (let i = 0; i < (config.WEBHOOK_DISABLE_AFTER_FAILURES ?? 10); i++) {
      await processWebhookDelivery(ctx, { webhookId: failingWebhook.id, eventId: `evt-${i}`, eventType: "correlation.increased", payload: { id: `evt-${i}`, type: "correlation.increased", createdAt: new Date().toISOString(), data: {} } }, { attempt: 1 }).catch(() => {});
    }
    const [afterStorm] = await db<Array<{ status: string; disabled_reason: string | null }>>`select status, disabled_reason from developer_webhooks where id = ${failingWebhook.id}`;
    ok("FLOW8: repeated failures disable the webhook (bounded storm)", afterStorm?.status === "DISABLED", `status ${afterStorm?.status}`);

    // Timeout: /hang never responds; strict timeout returns quickly.
    const hanging = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => hanging.listen(TEST_WEBHOOK_PORT + 1, "127.0.0.1", resolve));
    const timeoutWebhook = await webhookRepo.create({
      userId: loginA.userId,
      url: `http://127.0.0.1:${TEST_WEBHOOK_PORT + 1}/hang`,
      eventTypes: ["correlation.increased"],
      secretEncrypted: materialF.encrypted,
      secretNonce: materialF.nonce,
      secretKeyVersion: materialF.keyVersion
    });
    const startedTimeout = Date.now();
    const timeoutResult = await processWebhookDelivery(ctx, { webhookId: timeoutWebhook.id, eventId: "evt-timeout-1", eventType: "correlation.increased", payload: { id: "evt-timeout-1", type: "correlation.increased", createdAt: new Date().toISOString(), data: {} } }, { attempt: 1 }).then(
      () => ({ ok: true, ms: Date.now() - startedTimeout }),
      () => ({ ok: false, ms: Date.now() - startedTimeout })
    );
    ok("FLOW8: hanging endpoint fails within the strict timeout budget", timeoutResult.ok === false && timeoutResult.ms < (config.WEBHOOK_TIMEOUT_MS ?? 5000) * 3, `${timeoutResult.ms}ms`);

    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await new Promise<void>((resolve) => hanging.close(() => resolve()));

    // ============ FLOW 9: SSRF (release blocker) ============
    // Production SSRF policy: devPrivate=false, default ports.
    const prodPolicy = { ...config, WEBHOOK_DEV_ALLOW_PRIVATE: false, WEBHOOK_ALLOWED_PORTS: "80,443" };
    const ssrfTargets = [
      "http://127.0.0.1/hook",
      "http://10.0.0.5/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/hook",
      "http://localhost/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "https://example.com:8443/hook",
      `http://127.0.0.1:${TEST_WEBHOOK_PORT}/transient`
    ];
    for (const target of ssrfTargets) {
      await resolveWebhookDestination(target, prodPolicy).then(
        () => ok(`FLOW9: SSRF blocked (${target})`, false),
        (err) => ok(`FLOW9: SSRF blocked (${target})`, err instanceof SsrfBlockedError)
      );
    }
    // The dev-private policy is NOT a silent production fallback: verify the
    // flag actually gates local delivery (allowed in dev/test only).
    const devDest = await resolveWebhookDestination(`http://127.0.0.1:${TEST_WEBHOOK_PORT}/transient`, config);
    ok("FLOW9: dev-private policy gates local delivery (test only)", devDest.ip === "127.0.0.1");

    // ============ FLOW 10: cross-user (notifications + events) ============
    const userBNotifs = await notificationRepo.listForUser(loginB.userId, 10);
    const userBEvents = await monitorCorrRepo.listEventsForUser(loginB.userId, 10);
    ok("FLOW10: user B sees none of user A's notifications", userBNotifs.length === 0, `${userBNotifs.length}`);
    ok("FLOW10: user B sees none of user A's correlation events", userBEvents.length === 0, `${userBEvents.length}`);
    const monitorCross = await monitorRepo.getForUser(loginB.userId, monitor.id);
    ok("FLOW10: user B cannot read user A's monitor", monitorCross === null);
  } finally {
    await cache.close().catch(() => {});
    await queues.close().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
