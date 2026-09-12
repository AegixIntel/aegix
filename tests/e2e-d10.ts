import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { createDb, createWalletRepo, createAnalysisJobRepo, createIntelligenceRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { assessFreshness, type MarketDataProvider } from "../packages/markets/src/index.js";
import { buildServer } from "../apps/api/src/server.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

async function main() {
  const safe = requireSafeTestDatabaseReset();
  const config = loadConfig({ ...process.env, MARKETS_DAILY_QUOTA: "5" });
  const sql = createDb(safe.databaseUrl);
  const now = new Date();
  const provider: MarketDataProvider = { name: "e2e-d10-fixture", async getQuote(asset) { return { asset, priceUsd: 200, volume24hUsd: 1000, marketCapUsd: null, percentChange24h: null, provider: "e2e-d10-fixture", freshness: assessFreshness(now.toISOString(), now) }; },
    async getHistory() { return Array.from({ length: 24 }, (_, i) => ({ timestamp: new Date(now.getTime() - (23 - i) * 3600000).toISOString(), priceUsd: 100 + i % 3, volumeUsd: 100 })); } };
  const app = await buildServer({ config, marketProvider: provider });
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
    const wallet = await createWalletRepo(sql).findOrCreate("solana", address);
    const jobs = createAnalysisJobRepo(sql);
    const job = await jobs.create({ walletId: wallet.id, requestedBy: null, analysisType: "full", priority: "free" });
    await jobs.markCompleted(job.id, { chainDataUntil: now.toISOString(), freshUntil: new Date(now.getTime() + 3600000).toISOString() }, {
      transactionsParsed: 30, historyStart: new Date(now.getTime() - 86400000).toISOString(), historyEnd: now.toISOString(), grade: "HIGH", dataQualityScore: 90 });
    await createIntelligenceRepo(sql).insertSignals([{ analysisId: job.id, walletId: wallet.id,
      signalType: "KNOWN_ENTITY_INTERACTION", category: "ENTITY", severity: 50, confidence: 0.8,
      title: "Observed entity interaction", summary: "Interaction was observed within the analysed history.",
      evidence: [{ key: "timestamp", label: "Observed UTC time", value: new Date(now.getTime() - 3600000 + 60000).toISOString() }], engineVersion: "entities-v1.0.0" }]);
    const all = await app.inject({ url: "/v1/markets", headers });
    assert.equal(all.statusCode, 200); assert.equal(all.json().markets.length, 3);
    for (const asset of ["BTC", "ETH", "SOL"]) {
      const market = await app.inject({ url: `/v1/markets/${asset}`, headers });
      assert.equal(market.statusCode, 200); assert.equal(market.json().snapshot.quote.asset, asset);
      assert.equal(market.json().snapshot.history.length, 24); assert.ok(market.json().snapshot.signals.length > 0);
    }
    const temporal = await app.inject({ url: `/v1/markets/SOL?wallet=${address}`, headers });
    assert.equal(temporal.statusCode, 200); assert.equal(temporal.json().temporalContext.length, 1);
    assert.deepEqual(temporal.json().temporalContext[0].evidenceRefs, ["ind:KNOWN_ENTITY_INTERACTION", "cov:market:SOL:history"]);
    assert.equal((await app.inject({ url: "/v1/markets/BTC", headers })).statusCode, 429);
    const [usage] = await sql<Array<{ count: string }>>`select count(*)::text as count from usage_records where user_id = ${userId} and usage_type = 'markets'`;
    assert.equal(Number(usage?.count), 5);
    const explanation = await app.inject({ method: "POST", url: "/v1/markets/SOL/ask", headers, payload: { question: "Explain market activity" } });
    assert.equal(explanation.statusCode, 503);
    assert.equal((await app.inject({ url: `/v1/wallets/${address}/context`, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `/v1/wallets/${address}/x-ray` })).statusCode, 200);
    console.log("D10 authenticated API, temporal context, quota, metering and AI fail-open: PASS");
  } finally {
    await app.close();
    if (userId) { await sql`delete from usage_records where user_id = ${userId}`; await sql`delete from profiles where id = ${userId}`; }
    await sql.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "D10 E2E failure"); process.exitCode = 1; });
