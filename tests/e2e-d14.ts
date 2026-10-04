import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { createDb, createDiscoveryRepo, createObservationRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createLogger } from "@aegix/logging";
import { assessFreshness, type MarketDataProvider } from "../packages/markets/src/index.js";
import { DISCOVERY_WINDOW_HOURS, runScan } from "../packages/discovery/src/index.js";
import { tokenizedStockSeriesKey, type SeriesSource } from "../packages/sources/src/index.js";
import { anchorDiscoveryChain, captureMarketSignals, captureSeriesSource, captureTokenizedStockSignals, discoverySeries } from "../apps/worker/src/processors/intelligence.js";
import { buildServer } from "../apps/api/src/server.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

/**
 * D14 against a real PostgreSQL: append-only enforcement, capture
 * idempotency, the Rewind lock, and Discovery IDs with their hash chain.
 *
 * The D14 tables cannot be cleaned up — that is the property under test — so
 * every fixture carries a run-unique key and no assertion depends on the
 * tables being empty.
 */

const HOUR = 3_600_000;
const APPEND_ONLY = /append-only/;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
function changes(seed: number, length: number): number[] {
  const next = rng(seed);
  return Array.from({ length }, () => Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next()) * 0.01);
}

async function main() {
  const safe = requireSafeTestDatabaseReset();
  const sql = createDb(safe.databaseUrl);
  const run = randomUUID();
  const config = loadConfig({ ...process.env, ENABLE_REWIND: "true", ENABLE_DISCOVERY: "true", ENABLE_REWIND_CAPTURE: "true" });
  const logger = createLogger(config, { service: "e2e-d14" });
  const observations = createObservationRepo(sql);
  const discoveries = createDiscoveryRepo(sql);

  const now = new Date();
  const provider: MarketDataProvider = { name: `e2e-d14-${run}`,
    async getQuote(asset) { return { asset, priceUsd: 200, volume24hUsd: 1000, marketCapUsd: null, percentChange24h: null, provider: `e2e-d14-${run}`, freshness: assessFreshness(now.toISOString(), now) }; },
    async getHistory() { return Array.from({ length: 24 }, (_, i) => ({ timestamp: new Date(Math.floor(now.getTime() / HOUR) * HOUR - (23 - i) * HOUR).toISOString(), priceUsd: 100 + i % 3, volumeUsd: 100 + i })); } };

  const app = await buildServer({ config, marketProvider: provider });
  const disabled = await buildServer({ config: loadConfig({ ...process.env, ENABLE_REWIND: "false", ENABLE_DISCOVERY: "false" }), marketProvider: provider });
  const key = ed25519.utils.randomPrivateKey();
  const address = base58.encode(ed25519.getPublicKey(key));
  let userId: string | undefined;
  try {
    const challenge = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet: address } });
    const data = challenge.json().data;
    const verification = await app.inject({ method: "POST", url: "/v1/auth/wallet/verify", payload: {
      wallet: address, challengeId: data.challengeId, nonce: data.nonce,
      signature: base58.encode(ed25519.sign(new TextEncoder().encode(data.message), key)) } });
    assert.equal(verification.statusCode, 200);
    const auth = verification.json().data;
    userId = auth.user.id;
    const headers = { authorization: `Bearer ${auth.token}` };

    // ---- Ledger: append-only, first observation wins, no backdating ----
    const seriesKey = `e2e:${run}:price`;
    const eventTime = new Date(Math.floor(now.getTime() / HOUR) * HOUR).toISOString();
    assert.equal(await observations.appendPoints([{ seriesKey, eventTime, value: 10, source: "fixture" }]), 1);
    assert.equal(await observations.appendPoints([{ seriesKey, eventTime, value: 99, source: "fixture" }]), 0, "a revised value does not replace the first observation");
    const [point] = await observations.pointsBetween([seriesKey], new Date(Date.parse(eventTime) - HOUR).toISOString(), new Date(Date.parse(eventTime) + HOUR).toISOString());
    assert.equal(point?.value, 10);
    await assert.rejects(sql`update observation_points set value = 1 where series_key = ${seriesKey}`, APPEND_ONLY);
    await assert.rejects(sql`delete from observation_points where series_key = ${seriesKey}`, APPEND_ONLY);
    const backdatedKey = `e2e:${run}:backdated`;
    await sql`insert into observation_points (series_key, event_time, value, source, observed_at) values (${backdatedKey}, ${eventTime}, 1, 'fixture', '2000-01-01T00:00:00Z')`;
    const [backdated] = await sql<Array<{ recent: boolean }>>`select observed_at > now() - interval '5 minutes' as recent from observation_points where series_key = ${backdatedKey}`;
    assert.equal(backdated?.recent, true, "observed_at is the database clock, whatever the writer supplies");

    // ---- Capture: idempotent per bucket, and only then replayable ----
    const beforeCapture = new Date().toISOString();
    const first = await captureMarketSignals({ config, sql, logger }, provider, now);
    assert.equal(first.captured + first.skipped, 3);
    assert.equal(first.failed, 0);
    const second = await captureMarketSignals({ config, sql, logger }, provider, now);
    assert.equal(second.captured, 0, "a second sweep in the same bucket stores nothing");
    assert.equal(second.pointsAdded, 0);
    assert.ok(first.pointsAdded > 0, "provider history entered the ledger");
    // A rerun inside the same capture bucket finds the earlier run's capture;
    // the bucket, not this run, is what identifies it.
    const intervalMs = config.REWIND_CAPTURE_INTERVAL_SECONDS * 1000;
    const bucketStart = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs).toISOString();
    const [captureRow] = await sql<Array<{ id: string; signal_count: number }>>`
      select id::text, signal_count from signal_captures where subject = 'SOL' and bucket_start = ${bucketStart}`;
    assert.ok(captureRow, "the bucket holds a SOL capture");
    const capturedThisRun = first.captured > 0;
    await assert.rejects(sql`update signal_captures set signal_count = 0 where id = ${captureRow.id}`, APPEND_ONLY);
    await assert.rejects(sql`delete from signal_snapshots where capture_id = ${captureRow.id}`, APPEND_ONLY);

    // ---- Rewind: the lock ----
    const rewind = (payload: Record<string, unknown>, target = app) => target.inject({ method: "POST", url: "/v1/rewind", headers, payload });
    const afterCapture = new Date().toISOString();
    const seen = await rewind({ subjectType: "asset", subject: "SOL", eventTime: afterCapture, lookbackHours: 24 });
    assert.equal(seen.statusCode, 200);
    const replay = seen.json();
    assert.ok(replay.timeline.some((c: { id: string }) => c.id === captureRow.id), "a capture stored before the event is replayed");
    assert.ok(replay.timeline.every((c: { observedAt: string }) => c.observedAt < replay.lockedAt), "nothing at or after the lock is admitted");
    assert.equal(replay.checkpoints.length, 5);
    assert.notEqual(replay.verdict, "NO_COVERAGE");
    const locked = (await rewind({ subjectType: "asset", subject: "SOL", eventTime: beforeCapture, lookbackHours: 24 })).json();
    if (capturedThisRun) assert.ok(!locked.timeline.some((c: { id: string }) => c.id === captureRow.id), "a capture stored after the event time is hindsight and is refused");

    const walletReplay = await rewind({ subjectType: "wallet", subject: address, eventTime: afterCapture });
    assert.equal(walletReplay.statusCode, 200);
    assert.equal(walletReplay.json().verdict, "NO_COVERAGE", "a wallet never analysed has no record to replay");
    assert.equal((await rewind({ subjectType: "asset", subject: "DOGE", eventTime: afterCapture })).statusCode, 400);
    assert.equal((await rewind({ subjectType: "asset", subject: "SOL", eventTime: new Date(Date.now() + 86_400_000).toISOString() })).json().code, "EVENT_IN_FUTURE");
    assert.equal((await app.inject({ method: "POST", url: "/v1/rewind", payload: { subjectType: "asset", subject: "SOL", eventTime: afterCapture } })).statusCode, 401);
    assert.equal((await rewind({ subjectType: "asset", subject: "SOL", eventTime: afterCapture }, disabled)).statusCode, 403);

    // ---- Series sources: a tokenized stock enters the ledger and becomes replayable ----
    const stockSource: SeriesSource = { name: `e2e-d14-${run}`, series: [],
      async collect(at) { return [{ seriesKey: tokenizedStockSeriesKey("NVDAx", "price_usdc"), eventTime: at.toISOString(), value: 230.5, source: `e2e-d14-${run}` }]; } };
    assert.deepEqual(await captureSeriesSource({ config, sql, logger }, stockSource, now), { source: stockSource.name, read: 1, added: 1 });
    assert.equal((await captureSeriesSource({ config, sql, logger }, stockSource, now)).added, 0, "the same reading is not stored twice");
    const failing: SeriesSource = { name: "e2e-failing", series: [], async collect() { throw new Error("source offline"); } };
    await assert.rejects(captureSeriesSource({ config, sql, logger }, failing, now), /source offline/);
    const stockCapture = await captureTokenizedStockSignals({ config, sql, logger }, now);
    assert.equal(stockCapture.captured + stockCapture.skipped, 14, "every priced stock is accounted for");
    const [stockRow] = await sql<Array<{ id: string }>>`
      select id::text from signal_captures where subject = 'NVDAx' and bucket_start = ${bucketStart}`;
    assert.ok(stockRow, "the stock whose price was read has a capture");
    const [unread] = await sql<Array<{ count: string }>>`
      select count(*)::text as count from signal_captures where subject = 'TSLAx' and bucket_start = ${bucketStart} and provider = ${stockSource.name}`;
    assert.equal(Number(unread?.count), 0, "a stock with no reading in this sweep gets no capture");
    const stockReplay = await rewind({ subjectType: "asset", subject: "NVDAx", eventTime: new Date().toISOString(), lookbackHours: 24 });
    assert.equal(stockReplay.statusCode, 200);
    assert.ok(stockReplay.json().timeline.some((c: { id: string }) => c.id === stockRow.id));
    assert.ok(stockReplay.json().limitations.some((l: string) => l.includes("one on-chain pool")), "the replay says what a tokenized price is");
    const subjects = await app.inject({ url: "/v1/rewind/subjects" });
    assert.equal(subjects.statusCode, 200);
    assert.ok(subjects.json().assets.some((a: { subject: string; kind: string }) => a.subject === "NVDAx" && a.kind === "TOKENIZED_STOCK"));
    assert.equal(discoverySeries(config).length, 6, "only series whose capture is on are scanned");
    assert.equal(discoverySeries(loadConfig({ ...process.env, ENABLE_TOKENIZED_STOCK_CAPTURE: "true", ENABLE_NARRATIVE_CAPTURE: "true" })).length, 28 + 8);
    assert.equal(discoverySeries(loadConfig({ ...process.env, ENABLE_NARRATIVE_CONTEXT_CAPTURE: "true" })).length, 8, "the context reading is its own eight series");
    assert.equal(discoverySeries(loadConfig({ ...process.env, ENABLE_SECTOR_CAPTURE: "true" })).length, 16, "sector and commodity funds are sixteen series");

    // ---- Discovery: one ID per relationship, timestamped and chained ----
    const engineVersion = `e2e-d14-${run}`;
    const epochEnd = new Date(Math.floor(now.getTime() / (24 * HOUR)) * 24 * HOUR).toISOString();
    const length = 400;
    const a = changes(1, length);
    const own = changes(2, length);
    const b = own.map((value, i) => (i >= length - DISCOVERY_WINDOW_HOURS && i >= 2 ? a[i - 2]! + value * 0.3 : value));
    const toSeries = (keyName: string, values: number[]) => {
      let level = 100;
      return { key: keyName, label: keyName, group: keyName, points: values.map((change, i) => {
        level *= Math.exp(change);
        return { eventTime: new Date(Date.parse(epochEnd) - (length - i) * HOUR).toISOString(), value: level };
      }) };
    };
    const scan = runScan({ series: [toSeries(`e2e:${run}:a`, a), toSeries(`e2e:${run}:b`, b)], epochEnd, open: [] });
    assert.equal(scan.discoveries.length, 1, "the planted relationship is found");
    const write = { engineVersion, epochEnd, windowHours: 168, baselineHours: 168, fdrLevel: 0.05, method: "e2e",
      seriesCount: scan.seriesCount, hypothesesConsidered: scan.hypothesesConsidered, hypothesesTested: scan.hypothesesTested,
      rejections: scan.rejections, tests: scan.tests, discoveries: scan.discoveries, confirmations: scan.confirmations };
    const persisted = await discoveries.persistRun(write);
    assert.equal(persisted?.discoveryIds.length, 1);
    assert.equal(await discoveries.persistRun(write), null, "an epoch is recorded once");
    const discoveryId = persisted!.discoveryIds[0]!;

    const [chain] = await sql<Array<{ valid: boolean; linked: boolean; recent: boolean }>>`
      select
        d.chain_hash = encode(sha256(convert_to(coalesce(d.prev_chain_hash, '') || '|' || d.fingerprint || '|' ||
          to_char(d.detected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex') as valid,
        d.prev_chain_hash is not distinct from (select p.chain_hash from discoveries p where p.id < d.id order by p.id desc limit 1) as linked,
        d.detected_at > now() - interval '5 minutes' as recent
      from discoveries d where d.id = ${discoveryId}`;
    assert.deepEqual({ ...chain }, { valid: true, linked: true, recent: true }, "the Discovery ID commits to its timestamp and to the discovery before it");
    await assert.rejects(sql`update discoveries set detected_at = '2020-01-01' where id = ${discoveryId}`, APPEND_ONLY);
    await assert.rejects(sql`delete from discoveries where id = ${discoveryId}`, APPEND_ONLY);
    await assert.rejects(sql`update discovery_events set event_type = 'CONFIRMED' where discovery_id = ${discoveryId}`, APPEND_ONLY);
    const [tests] = await sql<Array<{ count: string }>>`select count(*)::text as count from discovery_tests where run_id = ${persisted!.runId}`;
    assert.equal(Number(tests?.count), scan.tests.length, "every hypothesis is on record, not only the one that was significant");

    const detail = await app.inject({ url: `/v1/discoveries/AEX-${discoveryId}`, headers });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().discovery.id, `AEX-${discoveryId}`);
    assert.equal(detail.json().discovery.status, "CANDIDATE");
    assert.equal(detail.json().run.hypothesesTested, scan.hypothesesTested);
    assert.equal(detail.json().events[0].type, "CANDIDATE");
    const list = await app.inject({ url: "/v1/discoveries?limit=100", headers });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().discoveries.some((d: { id: string }) => d.id === `AEX-${discoveryId}`));
    assert.equal((await app.inject({ url: "/v1/discoveries/not-an-id", headers })).statusCode, 400);
    assert.equal((await app.inject({ url: "/v1/discoveries/AEX-999999999999", headers })).statusCode, 404);
    assert.equal((await app.inject({ url: "/v1/discoveries" })).statusCode, 401);
    assert.equal((await disabled.inject({ url: "/v1/discoveries", headers })).statusCode, 403);

    // ---- Anchors: the chain head goes to each calendar once ----
    const calendars = ["https://one.calendar.test", "https://two.calendar.test"];
    const anchorCtx = { config: loadConfig({ ...process.env, DISCOVERY_ANCHOR_CALENDARS: calendars.join(",") }), sql, logger };
    const sent: Array<{ url: string; hash: string }> = [];
    const submit = async (url: string, hash: string) => {
      sent.push({ url, hash });
      if (url === calendars[1] && sent.length === 2) throw new Error("calendar down");
      return Uint8Array.from([0xf0, 0x01, sent.length]);
    };
    const firstSweep = await anchorDiscoveryChain(anchorCtx, submit);
    assert.deepEqual(firstSweep, { head: discoveryId, submitted: 1, failed: 1 }, "the newest discovery is the head; a calendar that fails is not stored");
    assert.deepEqual(await anchorDiscoveryChain(anchorCtx, submit), { head: discoveryId, submitted: 1, failed: 0 }, "only the calendar that failed is asked again");
    assert.deepEqual(await anchorDiscoveryChain(anchorCtx, submit), { head: discoveryId, submitted: 0, failed: 0 }, "a head every calendar holds is not sent again");
    assert.equal(sent.length, 3);
    const [head] = await sql<Array<{ chain_hash: string }>>`select chain_hash from discoveries where id = ${discoveryId}`;
    assert.ok(sent.every((s) => s.hash === head!.chain_hash), "what is sent is the chain hash and nothing else");
    await assert.rejects(sql`update discovery_anchors set submitted_at = '2020-01-01' where discovery_id = ${discoveryId}`, APPEND_ONLY);
    await assert.rejects(sql`delete from discovery_anchors where discovery_id = ${discoveryId}`, APPEND_ONLY);

    const anchored = await app.inject({ url: `/v1/discoveries/AEX-${discoveryId}`, headers });
    assert.equal(anchored.json().anchors.length, 2);
    assert.equal(anchored.json().anchors[0].covers, `AEX-${discoveryId}`);

    // The chain and its proofs need no session: a third party checks them.
    const links = await app.inject({ url: `/v1/discovery-chain?from=AEX-${discoveryId}` });
    assert.equal(links.statusCode, 200);
    const link = links.json().links[0] as { id: string; fingerprint: string; detectedAt: string; prevChainHash: string | null; chainHash: string };
    assert.equal(link.id, `AEX-${discoveryId}`);
    assert.equal(createHash("sha256").update(`${link.prevChainHash ?? ""}|${link.fingerprint}|${link.detectedAt}`).digest("hex"), link.chainHash,
      "a link can be recomputed from what the public endpoint returns");
    assert.equal(links.json().head.chainHash, link.chainHash);
    const anchorList = await app.inject({ url: "/v1/discovery-chain/anchors" });
    assert.equal(anchorList.statusCode, 200);
    const listed = (anchorList.json().anchors as Array<{ covers: string; chainHash: string; proofPath: string }>).find((x) => x.covers === `AEX-${discoveryId}`)!;
    const proof = await app.inject({ url: listed.proofPath });
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.headers["content-type"], "application/vnd.opentimestamps.v1");
    assert.equal(proof.rawPayload.subarray(1, 15).toString("latin1"), "OpenTimestamps");
    assert.equal(proof.rawPayload.subarray(33, 65).toString("hex"), link.chainHash, "the proof stamps this chain hash");
    assert.equal(proof.rawPayload[65], 0xf0);
    assert.equal((await app.inject({ url: "/v1/discovery-chain/anchors/nope.ots" })).statusCode, 400);
    assert.equal((await app.inject({ url: "/v1/discovery-chain/anchors/999999999999.ots" })).statusCode, 404);
    assert.equal((await app.inject({ url: "/v1/discovery-chain?from=x" })).statusCode, 400);
    assert.equal((await disabled.inject({ url: "/v1/discovery-chain" })).statusCode, 403);
    assert.equal((await disabled.inject({ url: "/v1/discovery-chain/anchors" })).statusCode, 403);

    console.log("D14 append-only ledger, capture idempotency, Rewind lock, Discovery ID chain, anchors and API: PASS");
  } finally {
    await app.close();
    await disabled.close();
    if (userId) await sql`delete from profiles where id = ${userId}`;
    await sql.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "D14 E2E failure"); process.exitCode = 1; });
