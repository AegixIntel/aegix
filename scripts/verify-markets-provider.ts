import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { loadConfig } from "@aegix/config";
import { createDb } from "@aegix/database";
import { createCache } from "@aegix/cache";
import { CANONICAL_ASSETS, createCoinPaprikaProvider, computeMarketSignals, type MarketDataProvider, type MarketSnapshot } from "../packages/markets/src/index.js";
import { buildServer } from "../apps/api/src/server.js";
import { requireSafeTestDatabaseReset } from "../tests/helpers/test-environment.js";

async function main() {
  const safe = requireSafeTestDatabaseReset();
  const config = loadConfig();
  const real = createCoinPaprikaProvider({ timeoutMs: 30000 });
  const calls = new Map<string, number>();
  const provider: MarketDataProvider = { name: real.name,
    getQuote(asset) { calls.set(`${asset}:quote`, (calls.get(`${asset}:quote`) ?? 0) + 1); return real.getQuote(asset); },
    getHistory(asset, days) { calls.set(`${asset}:history`, (calls.get(`${asset}:history`) ?? 0) + 1); return real.getHistory(asset, days); }
  };
  const cache = createCache(config.REDIS_URL);
  for (const asset of CANONICAL_ASSETS) await cache.del(`markets:coinpaprika:${asset}:1d:1h`);
  const app = await buildServer({ config, marketProvider: provider });
  const privateKey = ed25519.utils.randomPrivateKey();
  const wallet = base58.encode(ed25519.getPublicKey(privateKey));
  const sql = createDb(safe.databaseUrl);
  let userId: string | undefined;
  let failed = false;
  try {
    const challenge = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet } });
    assert.equal(challenge.statusCode, 200);
    const data = challenge.json().data;
    const signature = base58.encode(ed25519.sign(new TextEncoder().encode(data.message), privateKey));
    const verified = await app.inject({ method: "POST", url: "/v1/auth/wallet/verify", payload: { wallet, signature, challengeId: data.challengeId, nonce: data.nonce } });
    assert.equal(verified.statusCode, 200);
    const auth = verified.json().data;
    userId = auth.user.id;
    for (const asset of CANONICAL_ASSETS) {
      try {
        // The injected server uses the actual adapter and Redis cache, with no fixture data.
        const response = await app.inject({ url: `/v1/markets/${asset}`, headers: { authorization: `Bearer ${auth.token}` } });
        assert.equal(response.statusCode, 200, response.body);
        const snapshot = response.json().snapshot as MarketSnapshot;
        assert.equal(snapshot.quote.asset, asset); assert.equal(snapshot.quote.provider, "coinpaprika");
        assert.ok(Number.isFinite(snapshot.quote.priceUsd) && snapshot.quote.priceUsd > 0);
        assert.notEqual(snapshot.quote.freshness.status, "UNAVAILABLE");
        assert.ok(snapshot.history.length >= 7 && snapshot.history.length <= 24);
        assert.equal(snapshot.providerStatus, "OK");
        assert.deepEqual(snapshot.signals, computeMarketSignals({ asset, currentPrice: snapshot.quote.priceUsd, currentVolume: snapshot.quote.volume24hUsd, history: snapshot.history }));
        assert.ok(calls.get(`${asset}:quote`) && calls.get(`${asset}:history`), "both real network requests executed");
        console.log(`REAL ${asset}: PASS provider → normalization → ${snapshot.quote.freshness.status} → ${snapshot.history.length} history points → ${snapshot.signals.length} deterministic signals → authenticated API`);
      } catch { failed = true; console.error(`REAL ${asset}: FAIL`); }
    }
    console.log("Commercial licensing suitability is a separate production review; runtime verification makes no licensing claim.");
  } finally {
    await app.close();
    await cache.close();
    if (userId) { await sql`delete from usage_records where user_id = ${userId}`; await sql`delete from profiles where id = ${userId}`; }
    await sql.end();
  }
  if (failed) process.exitCode = 1;
}
main().catch(() => { console.error("Real market verification: FAIL"); process.exitCode = 1; });
