import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { createDb, createObservationRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { createLogger } from "@aegix/logging";
import { assessFreshness, type MarketDataProvider } from "../packages/markets/src/index.js";
import { ANOMALY_ENGINE_VERSION, NARRATIVE_RADAR_VERSION, SIGNAL_ENGINE_VERSION, CROSS_MARKET_ENGINE_VERSION } from "../packages/sources/src/index.js";
import { anomalySeries, captureMarketSignals, captureSeriesAnomalies } from "../apps/worker/src/processors/intelligence.js";
import { buildServer } from "../apps/api/src/server.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

/**
 * D15 against a real PostgreSQL: anomaly captures stored once and
 * append-only, and the four read APIs over the ledger and the captures.
 *
 * Like D14, these tables cannot be cleaned up, so every fixture carries a
 * run-unique key and no assertion depends on a table being empty.
 */

const HOUR = 3_600_000;
const APPEND_ONLY = /append-only/;
const FLAGS = { ENABLE_REWIND_CAPTURE: "true", ENABLE_ANOMALY_CAPTURE: "true", ENABLE_ANOMALY_DETECTION: "true", ENABLE_NARRATIVE_RADAR: "true", ENABLE_SIGNAL_ENGINE: "true", ENABLE_CROSS_MARKET: "true" };

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

async function main() {
  const safe = requireSafeTestDatabaseReset();
  const sql = createDb(safe.databaseUrl);
  const run = randomUUID();
  const config = loadConfig({ ...process.env, ...FLAGS });
  const logger = createLogger(config, { service: "e2e-d15" });
  const observations = createObservationRepo(sql);

  const now = new Date();
  const currentHour = Math.floor(now.getTime() / HOUR);
  const source = `e2e-d15-${run}`;
  const provider: MarketDataProvider = { name: source,
    async getQuote(asset) { return { asset, priceUsd: 200, volume24hUsd: 1000, marketCapUsd: null, percentChange24h: null, provider: source, freshness: assessFreshness(now.toISOString(), now) }; },
    async getHistory() { return Array.from({ length: 30 }, (_, i) => ({ timestamp: new Date((currentHour - (29 - i)) * HOUR).toISOString(), priceUsd: 100 + i, volumeUsd: 100 + i })); } };

  const app = await buildServer({ config, marketProvider: provider });
  const disabled = await buildServer({ config: loadConfig({ ...process.env, ...Object.fromEntries(Object.keys(FLAGS).map((flag) => [flag, "false"])) }), marketProvider: provider });
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
    const routes = ["/v1/narratives", "/v1/anomalies", "/v1/signals", "/v1/cross-market"];

    // ---- Gates: off by default, and a session is required ----
    for (const url of routes) {
      assert.equal((await disabled.inject({ url, headers })).statusCode, 403, `${url} is off unless its flag is set`);
      assert.equal((await app.inject({ url })).statusCode, 401, `${url} needs a session`);
    }

    // ---- Anomaly capture: one reading per series per hourly change ----
    const next = rng(7);
    const walk = (length: number, last: number) => {
      let level = 100;
      return Array.from({ length: length + 1 }, (_, i) => {
        if (i > 0) level *= Math.exp(i === length ? last : (next() - 0.5) * 0.008);
        return { eventTime: new Date((currentHour - 1 - length + i) * HOUR).toISOString(), value: level, source };
      });
    };
    const descriptors = ["spike", "calm", "short", "empty"].map((name) => ({ key: `e2e:${run}:${name}`, label: `E2E ${name}`, group: `e2e:${run}` }));
    const seed = (name: string, points: Array<{ eventTime: string; value: number; source: string }>) =>
      observations.appendPoints(points.map((p) => ({ ...p, seriesKey: `e2e:${run}:${name}` })));
    await seed("spike", walk(300, 0.07));
    await seed("calm", walk(300, 0.001));
    await seed("short", walk(30, 0.07));
    const ctx = { config, sql, logger };
    assert.deepEqual(await captureSeriesAnomalies(ctx, now, descriptors), { captured: 3, skipped: 1, failed: 0, pointsAdded: 0 }, "a series with no change on record gets no capture");
    assert.equal((await captureSeriesAnomalies(ctx, now, descriptors)).captured, 0, "an hourly change is read once");
    const stored = await sql<Array<{ subject: string; signal_count: number; quality_grade: string; engine_version: string; bucket_start: Date }>>`
      select subject, signal_count, quality_grade, engine_version, bucket_start from signal_captures
      where domain = 'ANOMALY' and subject like ${`e2e:${run}:%`} order by subject`;
    assert.deepEqual(stored.map((row) => [row.subject.split(":")[2], row.signal_count, row.quality_grade]), [["calm", 0, "HIGH"], ["short", 0, "LOW"], ["spike", 1, "HIGH"]]);
    assert.ok(stored.every((row) => row.engine_version === ANOMALY_ENGINE_VERSION && new Date(row.bucket_start).getTime() === (currentHour - 1) * HOUR), "the bucket is the hour the change ends in");
    await assert.rejects(sql`update signal_captures set signal_count = 0 where domain = 'ANOMALY' and subject = ${`e2e:${run}:spike`}`, APPEND_ONLY);
    await assert.rejects(sql`insert into signal_captures (domain, subject, bucket_start, engine_version, provider, provider_status, quality_grade, signal_count)
      values ('OTHER', 'x', now(), 'e2e', 'e2e', 'OK', 'HIGH', 0)`, /signal_captures_domain_check/);
    assert.equal(anomalySeries(config).length, 6, "only series whose capture is on are read");
    assert.equal(anomalySeries(loadConfig({ ...process.env, ENABLE_TOKENIZED_STOCK_CAPTURE: "true", ENABLE_NARRATIVE_CONTEXT_CAPTURE: "true", ENABLE_SECTOR_CAPTURE: "true", ENABLE_OPTIONS_CAPTURE: "true" })).length, 14 + 8,
      "token prices and news counts are read; supply, funds and options are not");

    const anomalies = await app.inject({ url: "/v1/anomalies?hours=24", headers });
    assert.equal(anomalies.statusCode, 200);
    const mine = (anomalies.json().anomalies as Array<{ series: string; type: string; label: string; engineVersion: string; evidence: Array<{ key: string }> }>).filter((a) => a.series.startsWith(`e2e:${run}:`));
    assert.deepEqual(mine.map((a) => [a.series, a.type]), [[`e2e:${run}:spike`, "SERIES_ANOMALY_UP"]], "only the capture that held a signal is listed");
    assert.ok(mine[0]!.evidence.some((e) => e.key === "robust_z"));
    assert.ok(anomalies.json().coverage.captures >= 3 && anomalies.json().coverage.signalled >= 1, "captures that found nothing are counted as coverage");
    assert.equal(anomalies.json().engineVersion, ANOMALY_ENGINE_VERSION);

    // ---- Narrative Radar: every topic of the fixed list, measured or not ----
    const radar = await app.inject({ url: "/v1/narratives", headers });
    assert.equal(radar.statusCode, 200);
    assert.equal(radar.json().engineVersion, NARRATIVE_RADAR_VERSION);
    const topics = radar.json().topics as Array<{ topic: string; state: string; series: unknown[]; storedSignals: unknown[] }>;
    assert.equal(topics.length, 8);
    assert.ok(topics.every((t) => ["ACCELERATING", "STEADY", "FADING", "INSUFFICIENT_DATA"].includes(t.state) && Array.isArray(t.series) && Array.isArray(t.storedSignals)));
    assert.equal(radar.json().capture.mentions, false, "the answer says the capture it reads is off");

    // ---- Signal Engine: stored signals of every domain on one timeline ----
    const signalType = `E2E_${run.slice(0, 8)}`;
    const fixture = (domain: "MARKET" | "NARRATIVE" | "SECTOR", subject: string) => observations.recordCapture({
      domain, subject, bucketStart: new Date(currentHour * HOUR).toISOString(), engineVersion: source, provider: source, providerStatus: "OK", qualityGrade: "HIGH",
      signals: [{ type: signalType, severity: 60, confidence: 1, title: `${subject} fixture`, summary: "fixture", evidence: [], engineVersion: source }] });
    assert.equal(await fixture("MARKET", "SOL"), true);
    assert.equal(await fixture("NARRATIVE", "copper"), true);
    assert.equal(await fixture("SECTOR", "XLU"), true);
    assert.equal(await fixture("SECTOR", "CPER"), true);
    const signals = await app.inject({ url: "/v1/signals?hours=24", headers });
    assert.equal(signals.statusCode, 200);
    const feed = signals.json();
    assert.equal(feed.engineVersion, SIGNAL_ENGINE_VERSION);
    const entries = (feed.entries as Array<{ domain: string; subject: string; marketClass: string; signalType: string }>).filter((e) => e.signalType === signalType);
    assert.deepEqual(entries.map((e) => `${e.domain}:${e.subject}:${e.marketClass}`).sort(),
      ["MARKET:SOL:CRYPTO", "NARRATIVE:copper:NEWS", "SECTOR:CPER:COMMODITY_FUND", "SECTOR:XLU:SECTOR_FUND"]);
    assert.ok(feed.entries.some((e: { domain: string; subject: string; marketClass: string }) => e.domain === "ANOMALY" && e.subject === `e2e:${run}:spike` && e.marketClass === "OTHER"),
      "an anomaly capture is on the timeline, under the class of its series");
    const confluence = (feed.confluences as Array<{ classes: string[]; subjects: Array<{ subject: string; signalTypes: string[] }> }>)
      .find((c) => c.subjects.some((s) => s.subject === "SOL" && s.signalTypes.includes(signalType)));
    assert.ok(confluence, "signals of several market classes stored together are a confluence");
    for (const marketClass of ["CRYPTO", "NEWS", "SECTOR_FUND", "COMMODITY_FUND"]) assert.ok(confluence.classes.includes(marketClass));
    assert.ok(!confluence.subjects.some((s) => s.subject.startsWith("e2e:")), "a series outside the market classes is not part of a confluence");
    assert.deepEqual((feed.coverage as Array<{ domain: string }>).map((c) => c.domain), ["MARKET", "NARRATIVE", "SECTOR", "ANOMALY"]);

    // ---- Cross-Market: measured on the ledger, only the classes being captured ----
    const captured = await captureMarketSignals(ctx, provider, now);
    assert.equal(captured.failed, 0);
    const cross = await app.inject({ url: "/v1/cross-market", headers });
    assert.equal(cross.statusCode, 200);
    const view = cross.json();
    assert.equal(view.engineVersion, CROSS_MARKET_ENGINE_VERSION);
    assert.deepEqual(view.capture, { crypto: true, tokenizedStocks: false, funds: false });
    assert.deepEqual((view.classes as Array<{ marketClass: string }>).map((c) => c.marketClass), ["CRYPTO"], "a class whose capture is off is not shown");
    const sol = (view.classes[0].members as Array<{ symbol: string; price: number | null; return24hPercent: number | null }>).find((m) => m.symbol === "SOL")!;
    assert.equal(sol.price, 129, "the newest price on record");
    assert.equal(sol.return24hPercent, Number(((129 / 105 - 1) * 100).toFixed(2)), "against the price a day before, from the same source");
    assert.deepEqual(view.sectors, []);

    console.log("D15 anomaly captures, Narrative Radar, Signal Engine, Cross-Market and their gates: PASS");
  } finally {
    await app.close();
    await disabled.close();
    if (userId) await sql`delete from profiles where id = ${userId}`;
    await sql.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "D15 E2E failure"); process.exitCode = 1; });
