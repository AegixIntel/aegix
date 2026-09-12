import { assessFreshness, assessQuality, marketCacheKey, normalizeHistory } from "./normalize.js";
import { computeMarketSignals } from "./signals.js";
import { MARKETS_ENGINE_VERSION, MarketError, isCanonicalAsset, type CanonicalAsset, type MarketDataProvider, type MarketSnapshot } from "./types.js";

export interface MarketCache {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<unknown>;
}
interface CachedMarket { fetchedAt: number; snapshot: MarketSnapshot }

export function createMarketService(options: { provider: MarketDataProvider; cache?: MarketCache; now?: () => Date; cacheSeconds?: number }) {
  const now = options.now ?? (() => new Date());
  const local = new Map<CanonicalAsset, CachedMarket>();
  const pending = new Map<CanonicalAsset, Promise<MarketSnapshot>>();
  function refresh(entry: CachedMarket, degraded: boolean): MarketSnapshot {
    const quote = { ...entry.snapshot.quote, freshness: assessFreshness(entry.snapshot.quote.freshness.providerTimestamp, now()) };
    const history = normalizeHistory(entry.snapshot.history).filter((p) => now().getTime() - Date.parse(p.timestamp) <= 86_400_000 && Date.parse(p.timestamp) <= now().getTime()).slice(-24);
    const quality = assessQuality({ freshness: quote.freshness, history, volume24hUsd: quote.volume24hUsd, expectedPoints: 24 });
    if (degraded) { quality.grade = "LOW"; quality.issues.push("Provider unavailable; cached observations only."); }
    return { ...entry.snapshot, quote, history, quality, providerStatus: degraded ? "DEGRADED" : "OK",
      signals: quote.freshness.status === "UNAVAILABLE" ? [] : computeMarketSignals({ asset: quote.asset, currentPrice: quote.priceUsd, currentVolume: quote.volume24hUsd, history }) };
  }
  async function load(asset: CanonicalAsset): Promise<MarketSnapshot> {
    const key = marketCacheKey(options.provider.name, asset, "1d:1h");
    let cached = local.get(asset);
    if (!cached && options.cache) {
      try {
        const candidate = await options.cache.getJson<CachedMarket>(key);
        if (candidate && Number.isFinite(candidate.fetchedAt) && candidate.fetchedAt <= now().getTime() + 60_000 &&
          candidate.snapshot?.quote?.asset === asset && candidate.snapshot.quote.provider === options.provider.name &&
          Number.isFinite(candidate.snapshot.quote.priceUsd) && candidate.snapshot.quote.priceUsd > 0 &&
          candidate.snapshot.quote.freshness && Array.isArray(candidate.snapshot.history) &&
          candidate.snapshot.history.length <= 24 && candidate.snapshot.history.every((p) => p && typeof p.timestamp === "string" && Number.isFinite(p.priceUsd)) &&
          Array.isArray(candidate.snapshot.limitations) && candidate.snapshot.limitations.every((s) => typeof s === "string")) cached = candidate;
      } catch { /* malformed or unavailable cache must not suppress a real provider request */ }
    }
    if (cached && now().getTime() - cached.fetchedAt < (options.cacheSeconds ?? 60) * 1000) return refresh(cached, cached.snapshot.providerStatus === "DEGRADED");
    try {
      const results = await Promise.allSettled([options.provider.getQuote(asset), options.provider.getHistory(asset, 1)]);
      const quoteResult = results[0]!;
      const historyResult = results[1]!;
      if (quoteResult.status === "rejected") throw quoteResult.reason;
      const quote = quoteResult.value;
      if (quote.asset !== asset || quote.provider !== options.provider.name || !Number.isFinite(quote.priceUsd) || quote.priceUsd <= 0) throw new MarketError("MALFORMED_RESPONSE", "Invalid normalized identity or price");
      const history = historyResult.status === "fulfilled" ? normalizeHistory(historyResult.value).slice(-24) : cached?.snapshot.history ?? [];
      const snapshot: MarketSnapshot = { quote, history, quality: assessQuality({ freshness: quote.freshness, history, volume24hUsd: quote.volume24hUsd, expectedPoints: 24 }),
        signals: [], engineVersion: MARKETS_ENGINE_VERSION, providerStatus: "OK",
        limitations: ["History is bounded to one day of hourly observations. Volume observations are rolling 24h totals and overlap.", "Anomaly does not establish manipulation. Temporal correlation does not establish causation."] };
      const entry = { fetchedAt: now().getTime(), snapshot };
      const output = refresh(entry, historyResult.status === "rejected");
      entry.snapshot = output;
      local.set(asset, entry);
      try { await options.cache?.setJson(key, entry, 3600); } catch { /* bounded local cache remains available */ }
      return output;
    } catch (error) {
      if (cached) return refresh(cached, true);
      throw error instanceof MarketError ? error : new MarketError("PROVIDER_ERROR", "Market data unavailable");
    }
  }
  return { getSnapshot(asset: CanonicalAsset): Promise<MarketSnapshot> {
    if (!isCanonicalAsset(asset)) return Promise.reject(new MarketError("UNKNOWN_ASSET", "Unsupported market asset"));
    const existing = pending.get(asset);
    if (existing) return existing;
    const request = load(asset).finally(() => pending.delete(asset));
    pending.set(asset, request);
    return request;
  } };
}
