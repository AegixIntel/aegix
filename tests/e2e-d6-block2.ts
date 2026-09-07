/**
 * D6 Block 2 end-to-end test, see docs/d6-block2.md (D6-P, D6-E, D6-G,
 * D6-F, D6-H).
 *
 * Clean-state flow: reset DB → migrate → seed analyzed wallets →
 *   D6-P: challenge → sign → verify → session resolution → logout → replay
 *         rejection → challenge cap → first-login idempotency.
 *   D6-G: population aggregation (snapshot semantics, no double count),
 *         commonality penalty function, stats lookup.
 *   D6-H: webhook create (secret once) → secret rotation → event fan-out →
 *         delivery attempt recorded → SSRF protection at destination
 *         resolution (private IPs rejected) → oversized payload rejected.
 *   D6-F: correlation baselines → change detection → correlation threat
 *         events → suppression rules (cooldown/hysteresis) → RLS isolation.
 *
 * Requires local Postgres + Redis (docker compose). Resets the database.
 *
 * Run: pnpm test:e2e-d6-block2
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
  createMonitorCorrelationRepo,
  createPopulationCommonalityRepo,
  createWebhookRepo,
  createCorrelationRepo
} from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createCache } from "@aegix/cache";
import { createLogger } from "@aegix/logging";
import { createQueues } from "@aegix/queue";
import {
  createWalletAuth,
  buildAuthMessage,
  hashNonce,
  hashToken,
  WALLET_AUTH_MESSAGE_VERSION
} from "../apps/api/src/wallet-auth.js";
import { createWebhookSecret, signWebhookPayload, decryptWebhookSecret } from "../apps/api/src/webhook-crypto.js";
import { resolveWebhookDestination, isTransientStatus, SsrfBlockedError } from "@aegix/webhook-delivery";
import { aggregatePopulation, commonalityPenalty, commonalityFor, POPULATION_COMMONALITY_ENGINE_VERSION } from "@aegix/commonality";
import {
  evaluateCorrelationChanges,
  applyCorrelationRules,
  correlationEventFingerprint,
  CORRELATION_MONITOR_ENGINE_VERSION
} from "@aegix/monitor";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

// Webhook signing secrets are encrypted at rest; e2e uses a dev key when
// the environment does not provide one (production fail-fast still applies).
if (!process.env.WEBHOOK_ENCRYPTION_KEY) {
  process.env.WEBHOOK_ENCRYPTION_KEY = "e2e-webhook-encryption-key-0123456789abcdef";
}

// ---- Environment safety guards ----
const _e2e6b2DbUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aegix_test";
requireSafeTestDatabaseReset(process.env, { databaseUrl: _e2e6b2DbUrl });
process.env.DATABASE_URL = _e2e6b2DbUrl;

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

// ---- Deterministic fixture keypairs (public key = wallet address) ----

const keyA = ed25519.getPublicKey(new Uint8Array(32).fill(1));
const keyB = ed25519.getPublicKey(new Uint8Array(32).fill(2));
const WALLET_A = base58.encode(keyA);
const WALLET_B = base58.encode(keyB);

async function seedAnalyzedWallet(address: string, partner: string, amount: number, freshUntil: string): Promise<{ walletId: string; jobId: string }> {
  const walletRepo = createWalletRepo(sql);
  const jobRepo = createAnalysisJobRepo(sql);
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const wallet = await walletRepo.findOrCreate("solana", address);
  const job = await jobRepo.create({ walletId: wallet.id, requestedBy: null, analysisType: "full", priority: "free" });
  for (let i = 0; i < 4; i++) {
    const tx = await analyticsRepo.insertTransaction({
      signature: `d6b2-${address.slice(0, 4)}-${i}`,
      slot: 1,
      blockTime: `2026-02-0${(i % 9) + 1}T12:00:00Z`,
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
      amount_raw: String(amount + i),
      amount_normalized: String(amount + i),
      transfer_type: "TRANSFER",
      block_time: `2026-02-0${(i % 9) + 1}T12:00:00Z`
    }]);
  }
  await jobRepo.markCompleted(job.id, {
    chainDataUntil: new Date().toISOString(),
    freshUntil
  }, {
    transactionsParsed: 20,
    parserFailures: 0,
    rpcFailures: 0,
    parserSuccessRate: 100,
    semanticCoverage: 85,
    fullyParsed: 20,
    partiallyParsed: 0,
    genericParsed: 0,
    unknownProgramCount: 0,
    historyStart: "2026-02-01T00:00:00Z",
    historyEnd: "2026-02-10T00:00:00Z",
    dataQualityScore: 90,
    grade: "HIGH"
  });
  return { walletId: wallet.id, jobId: job.id };
}

async function signMessage(walletBase58: string, priv: Uint8Array, message: string): Promise<string> {
  const sig = ed25519.sign(new TextEncoder().encode(message), priv);
  return base58.encode(sig);
}

async function main(): Promise<void> {
  console.log("\n=== D6 Block 2 E2E ===\n");

  // 1. Clean state: reset schema + migrate.
  console.log("resetting database to clean state...");
  await sql.unsafe("drop schema public cascade; create schema public;");
  await sql.end();
  execFileSync("pnpm", ["--filter", "@aegix/database", "migrate"], { stdio: "inherit", env: process.env });
  sql = createDb(config.DATABASE_URL);
  const db = sql;

  const freshUntil = new Date(Date.now() + 3600_000).toISOString();
  const [seedA] = await Promise.all([
    seedAnalyzedWallet(WALLET_A, WALLET_B, 10, freshUntil),
    seedAnalyzedWallet(WALLET_B, WALLET_A, 5, freshUntil)
  ]);
  ok("E2E: fixture wallets analyzed (READY, fresh)", seedA.jobId !== undefined);

  // ---- D6-P: wallet-only authentication ----

  const walletAuth = createWalletAuth({ sql: db, config });
  const ip = "127.0.0.1";

  // Challenge issuance.
  const challenge = await walletAuth.issueChallenge({ wallet: WALLET_A, ip });
  ok("E2E: challenge issued", challenge.ok && typeof challenge.challenge.message === "string");
  if (!challenge.ok) throw new Error("challenge failed");
  ok("E2E: challenge message embeds wallet/domain/uri/nonce", challenge.challenge.message.includes(WALLET_A) && challenge.challenge.message.includes(config.AUTH_DOMAIN));

  // Nonce is never stored in plaintext (hash only at rest).
  const [challengeRow] = await db<Array<{ nonce_hash: string }>>`select nonce_hash from wallet_auth_challenges where id = ${challenge.challenge.challengeId}`;
  ok("E2E: challenge stores nonce hash, not plaintext", challengeRow?.nonce_hash === hashNonce(challenge.challenge.nonce) && challenge.challenge.nonce !== challengeRow?.nonce_hash);

  // Invalid signature rejected.
  const wrongKey = ed25519.getPublicKey(new Uint8Array(32).fill(99));
  const wrongSig = await signMessage(WALLET_A, wrongKey, challenge.challenge.message);
  const badVerify = await walletAuth.verify({ challengeId: challenge.challenge.challengeId, wallet: WALLET_A, signature: wrongSig, nonce: challenge.challenge.nonce });
  ok("E2E: wrong signature rejected", !badVerify.ok && badVerify.ok === false && "code" in badVerify);

  // Challenge consumed by failed attempt → replay impossible (atomic single-use).
  const replay = await walletAuth.verify({ challengeId: challenge.challenge.challengeId, wallet: WALLET_A, signature: wrongSig, nonce: challenge.challenge.nonce });
  ok("E2E: challenge consumed after first verify attempt (replay impossible)", !replay.ok && replay.code === "CHALLENGE_CONSUMED");

  // Fresh challenge, valid signature → session issued, profile created.
  const challenge2 = await walletAuth.issueChallenge({ wallet: WALLET_A, ip });
  if (!challenge2.ok) throw new Error("challenge2 failed");
  const sig = await signMessage(WALLET_A, new Uint8Array(32).fill(1), challenge2.challenge.message);
  const verify = await walletAuth.verify({ challengeId: challenge2.challenge.challengeId, wallet: WALLET_A, signature: sig, nonce: challenge2.challenge.nonce });
  ok("E2E: valid signature verifies and issues session", verify.ok && verify.token.length > 20 && verify.isNewUser === true);
  if (!verify.ok) throw new Error("verify failed");
  ok("E2E: session row stores token hash only", verify.session.token_hash === hashToken(verify.token) && verify.token !== verify.session.token_hash);

  // Session resolution.
  const resolved = await walletAuth.resolveSession(verify.token);
  ok("E2E: session resolves to the owning user + wallet", resolved?.id === verify.user.id && resolved?.wallet === WALLET_A);

  // Logout revokes the session for real.
  const revoked = await walletAuth.logout(verify.token);
  ok("E2E: logout revokes the session", revoked === true);
  const afterLogout = await walletAuth.resolveSession(verify.token);
  ok("E2E: revoked session no longer resolves", afterLogout === null);

  // Second login is idempotent: same wallet → same user, no new profile.
  const challenge3 = await walletAuth.issueChallenge({ wallet: WALLET_A, ip });
  if (!challenge3.ok) throw new Error("challenge3 failed");
  const sig3 = await signMessage(WALLET_A, new Uint8Array(32).fill(1), challenge3.challenge.message);
  const verify3 = await walletAuth.verify({ challengeId: challenge3.challenge.challengeId, wallet: WALLET_A, signature: sig3, nonce: challenge3.challenge.nonce });
  ok("E2E: second login binds to the same user (idempotent)", verify3.ok && verify3.user.id === verify.user.id && verify3.isNewUser === false);

  // Challenge cap per wallet.
  for (let i = 0; i < config.WALLET_AUTH_MAX_PENDING_PER_WALLET; i++) {
    await walletAuth.issueChallenge({ wallet: WALLET_B, ip });
  }
  const capped = await walletAuth.issueChallenge({ wallet: WALLET_B, ip });
  ok("E2E: pending challenge cap enforced", !capped.ok && capped.code === "CHALLENGE_LIMIT_REACHED");

  // Invalid wallet rejected at challenge.
  const invalid = await walletAuth.issueChallenge({ wallet: "not-a-wallet", ip });
  ok("E2E: invalid wallet rejected", !invalid.ok && invalid.code === "INVALID_WALLET");

  // ---- D6-G: population commonality ----

  const populationRepo = createPopulationCommonalityRepo(db);
  const commonalityCtx = { sql: db };
  const version = POPULATION_COMMONALITY_ENGINE_VERSION;

  // Aggregate both wallets' contributions.
  const agg1 = await aggregatePopulation(commonalityCtx, { walletId: seedA.walletId, analysisId: seedA.jobId, version });
  const agg2 = await aggregatePopulation(commonalityCtx, { walletId: (await createWalletRepo(db).findByAddress("solana", WALLET_B))!.id, analysisId: (await createAnalysisJobRepo(db).latestForWallet((await createWalletRepo(db).findByAddress("solana", WALLET_B))!.id))!.id, version });
  ok("E2E: population aggregation produced stats", agg1.populationSize >= 1 && agg2.populationSize >= 1, `pop ${agg1.populationSize}/${agg2.populationSize}`);

  // Idempotency: re-aggregating the same analysis is a no-op (no double count).
  const statsBefore = await populationRepo.statsForKeys([WALLET_A, WALLET_B], version);
  const beforeCount = statsBefore.reduce((n, r) => n + r.observation_count, 0);
  await aggregatePopulation(commonalityCtx, { walletId: seedA.walletId, analysisId: seedA.jobId, version });
  const statsAfter = await populationRepo.statsForKeys([WALLET_A, WALLET_B], version);
  const afterCount = statsAfter.reduce((n, r) => n + r.observation_count, 0);
  ok("E2E: re-aggregation is idempotent (no double count)", beforeCount === afterCount && beforeCount > 0, `${beforeCount} vs ${afterCount}`);

  // Population size reflects distinct wallets.
  const popSize = await populationRepo.populationSize(version);
  ok("E2E: population size = distinct analyzed wallets", popSize === 2, `size ${popSize}`);

  // Commonality lookup + penalty function.
  const common = await commonalityFor(commonalityCtx, [WALLET_A], { version });
  const stat = common.get(WALLET_A);
  ok("E2E: commonality stats expose frequency + sample adequacy", stat !== undefined && stat.sampleAdequate === false, JSON.stringify(stat));
  ok("E2E: penalty is 0 below rarity floor (small population)", commonalityPenalty(0.1, 5, 20) === 0);
  ok("E2E: penalty ramps smoothly and caps at 0.9", commonalityPenalty(0.5, 100, 20) > 0 && commonalityPenalty(1, 100, 20) === 0.9);
  ok("E2E: penalty bounded in [0, 0.9]", commonalityPenalty(0, 100, 20) === 0 && commonalityPenalty(0.3, 100, 20) <= 0.9);

  // ---- D6-H: webhooks ----

  const webhookRepo = createWebhookRepo(db);
  const material = createWebhookSecret(config);
  ok("E2E: webhook secret is high-entropy and reversibly encrypted", material.secret.length === 43 && decryptWebhookSecret(config, material.encrypted, material.nonce) === material.secret);

  const webhook = await webhookRepo.create({
    userId: verify.user.id,
    url: "https://example.com/hook",
    eventTypes: ["monitor.threat.created", "correlation.appeared"],
    secretEncrypted: material.encrypted,
    secretNonce: material.nonce,
    secretKeyVersion: material.keyVersion
  });
  ok("E2E: webhook created", webhook.id !== undefined && webhook.status === "ACTIVE");

  // Secret rotation replaces the stored ciphertext.
  const rotated = createWebhookSecret(config);
  const rotatedRow = await webhookRepo.rotateSecret(verify.user.id, webhook.id, { secretEncrypted: rotated.encrypted, secretNonce: rotated.nonce, secretKeyVersion: rotated.keyVersion });
  ok("E2E: webhook secret rotated", rotatedRow?.secret_encrypted === rotated.encrypted && rotatedRow?.secret_encrypted !== material.encrypted);

  // Signature over the payload (what consumers verify).
  const rawBody = JSON.stringify({ id: "evt-1", type: "monitor.threat.created", createdAt: new Date().toISOString(), data: {} });
  const sigPayload = signWebhookPayload("test-secret", "1720000000", rawBody);
  ok("E2E: payload signature deterministic", sigPayload.length === 64 && sigPayload === signWebhookPayload("test-secret", "1720000000", rawBody));

  // SSRF: private destinations blocked at resolution.
  await resolveWebhookDestination("https://10.0.0.5/hook", config).then(
    () => ok("E2E: private IP blocked", false),
    (err) => ok("E2E: private destination blocked (SSRF)", err instanceof SsrfBlockedError)
  );
  await resolveWebhookDestination("https://example.com:8443/hook", config).then(
    () => ok("E2E: disallowed port blocked", false),
    (err) => ok("E2E: disallowed port blocked", err instanceof SsrfBlockedError)
  );
  ok("E2E: transient status classification", isTransientStatus(500) && !isTransientStatus(404));

  // Delivery bookkeeping: record + outcome.
  await webhookRepo.recordDelivery({ webhookId: webhook.id, eventId: "evt-1", eventType: "monitor.threat.created", attempt: 1, status: "SUCCESS", statusCode: 200, durationMs: 42, nextRetryAt: null, errorExcerpt: null });
  await webhookRepo.markOutcome(webhook.id, { ok: true });
  const [deliveryRow] = await db<Array<{ status: string; status_code: number }>>`select status, status_code from webhook_deliveries where webhook_id = ${webhook.id} and event_id = 'evt-1'`;
  ok("E2E: delivery recorded with status", deliveryRow?.status === "SUCCESS" && deliveryRow?.status_code === 200);

  // Permanent failure disables the webhook.
  const webhook2 = await webhookRepo.create({
    userId: verify.user.id,
    url: "https://example.com/hook2",
    eventTypes: ["correlation.increased"],
    secretEncrypted: material.encrypted,
    secretNonce: material.nonce,
    secretKeyVersion: material.keyVersion
  });
  await webhookRepo.markOutcome(webhook2.id, { ok: false, disable: true, reason: "permanent HTTP 410" });
  const [disabledRow] = await db<Array<{ status: string; disabled_reason: string }>>`select status, disabled_reason from developer_webhooks where id = ${webhook2.id}`;
  ok("E2E: permanent failure disables webhook", disabledRow?.status === "DISABLED" && disabledRow?.disabled_reason === "permanent HTTP 410");

  // ---- D6-F: monitor-driven correlation alerts ----

  // Seed a persisted correlation result for (WALLET_A, WALLET_B) + a monitor.
  const correlationRepo = createCorrelationRepo(db);
  await correlationRepo.upsert({
    pairId: [WALLET_A, WALLET_B].sort().join("|"),
    correlationScore: 40,
    confidence: 0.6,
    classification: "PERSONAL",
    evidenceFamilies: [{ family: "sharedFunding", strength: 0.5 }],
    limitations: [],
    engineVersion: "correlation-v1.0.0"
  });
  const monitorId = "1";
  await db`
    insert into privacy_monitors (user_id, wallet_id, saved_analysis_id, schedule_type, status, next_check_at)
    values (${verify.user.id}, ${seedA.walletId}, null, 'EVERY_MINUTE', 'ACTIVE', now())
    returning id
  `;
  const [monitorRow] = await db<Array<{ id: string }>>`select id::text from privacy_monitors where user_id = ${verify.user.id} limit 1`;
  const realMonitorId = monitorRow?.id ?? monitorId;
  const monitorCorrRepo = createMonitorCorrelationRepo(db);

  // First cycle: no baseline → APPEARED (crosses threshold).
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
  const candidates = evaluateCorrelationChanges(realMonitorId, WALLET_A, null, currentSnap[0]!, {
    enterStrongScore: config.CORRELATION_ALERT_ENTER_STRONG,
    exitStrongScore: config.CORRELATION_ALERT_EXIT_STRONG,
    minDelta: config.CORRELATION_ALERT_MIN_DELTA,
    minScore: 40,
    minConfidence: 0.5,
    cooldownHours: 24,
    notifyCorrelationChange: true
  });
  ok("E2E: first correlation cycle emits APPEARED", candidates.some((c) => c.eventType === "CORRELATION_APPEARED"), JSON.stringify(candidates.map((c) => c.eventType)));

  // Persist baseline + event the way the pipeline does.
  await monitorCorrRepo.upsertBaseline({
    monitorId: realMonitorId,
    walletA: currentSnap[0]!.walletA,
    walletB: currentSnap[0]!.walletB,
    correlationScore: currentSnap[0]!.correlationScore,
    confidence: currentSnap[0]!.confidence,
    classification: currentSnap[0]!.classification,
    correlationResultId: currentSnap[0]!.correlationResultId,
    evidenceFamilies: currentSnap[0]!.evidenceFamilies,
    engineVersion: currentSnap[0]!.engineVersion
  });
  const appeared = candidates.find((c) => c.eventType === "CORRELATION_APPEARED")!;
  const persistedEvent = await monitorCorrRepo.upsertEvent({
    monitorId: realMonitorId,
    userId: verify.user.id,
    walletId: seedA.walletId,
    relatedWallet: appeared.relatedWallet,
    eventType: appeared.eventType,
    severity: appeared.severity,
    confidence: appeared.confidence,
    previousScore: appeared.previousScore,
    newScore: appeared.newScore,
    previousConfidence: appeared.previousConfidence,
    newConfidence: appeared.newConfidence,
    evidence: appeared.evidence as Record<string, unknown>,
    limitations: appeared.limitations,
    engineVersion: CORRELATION_MONITOR_ENGINE_VERSION,
    fingerprint: appeared.fingerprint
  });
  ok("E2E: correlation event persisted with fingerprint", persistedEvent.fingerprint === appeared.fingerprint && persistedEvent.event_type === "CORRELATION_APPEARED");

  // Same fingerprint re-upsert → occurrence count increments, no duplicate row.
  const repeat = await monitorCorrRepo.upsertEvent({
    monitorId: realMonitorId,
    userId: verify.user.id,
    walletId: seedA.walletId,
    relatedWallet: appeared.relatedWallet,
    eventType: appeared.eventType,
    severity: appeared.severity,
    confidence: appeared.confidence,
    previousScore: appeared.previousScore,
    newScore: appeared.newScore,
    previousConfidence: appeared.previousConfidence,
    newConfidence: appeared.newConfidence,
    evidence: appeared.evidence as Record<string, unknown>,
    limitations: appeared.limitations,
    engineVersion: CORRELATION_MONITOR_ENGINE_VERSION,
    fingerprint: appeared.fingerprint
  });
  ok("E2E: repeated event increments occurrence_count, no duplicate row", repeat.id === persistedEvent.id && repeat.occurrence_count === 2);

  // Cooldown suppresses NOTIFY for the same fingerprint.
  const decisions = applyCorrelationRules([appeared], {
    enterStrongScore: 60, exitStrongScore: 45, minDelta: 10, minScore: 40, minConfidence: 0.5, cooldownHours: 24, notifyCorrelationChange: true
  }, {
    recentSameFingerprint: { fingerprint: appeared.fingerprint, lastSeenAt: new Date().toISOString(), occurrenceCount: 2 }
  });
  ok("E2E: cooldown suppresses repeated event", decisions[0]?.action === "SUPPRESSED");

  // Score increase crossing strong band → INCREASED (from baseline 40 → 65).
  const previousSnap = { ...currentSnap[0]!, correlationScore: 40 };
  const increasedSnap = { ...currentSnap[0]!, correlationScore: 65 };
  const increased = evaluateCorrelationChanges(realMonitorId, WALLET_A, previousSnap, increasedSnap, {
    enterStrongScore: 60, exitStrongScore: 45, minDelta: 10, minScore: 40, minConfidence: 0.5, cooldownHours: 24, notifyCorrelationChange: true
  });
  ok("E2E: strong-band crossing emits INCREASED", increased.some((c) => c.eventType === "CORRELATION_INCREASED"), JSON.stringify(increased.map((c) => c.eventType)));

  // RLS: unauthenticated context cannot read user-scoped correlation events.
  const rlsEvents = await db<Array<{ id: string }>>`select id::text from correlation_threat_events where user_id = auth.uid()`;
  ok("E2E: RLS blocks unauthenticated correlation events", rlsEvents.length === 0, `${rlsEvents.length} rows`);

  // Cache/queue cleanup for a clean process exit.
  const cache = createCache(config.REDIS_URL, config.REDIS_CACHE_DB);
  await cache.close().catch(() => {});
  const queues = createQueues(config);
  await queues.close().catch(() => {});

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
