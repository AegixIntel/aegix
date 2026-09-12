import { assessFreshness, normalizeHistory } from "./normalize.js";
import { MarketError, isCanonicalAsset, type CanonicalAsset, type MarketDataProvider } from "./types.js";

export const COINPAPRIKA_IDS: Record<CanonicalAsset, string> = { BTC: "btc-bitcoin", ETH: "eth-ethereum", SOL: "sol-solana" };
export const MAX_HISTORY_POINTS = 288;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MarketError("MALFORMED_RESPONSE", "Expected market object");
  return value as Record<string, unknown>;
}
function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Keyless adapter: one bounded day of hourly observations, not fabricated OHLC. */
export function createCoinPaprikaProvider(options: { baseUrl?: string; fetchImpl?: typeof fetch; now?: () => Date; timeoutMs?: number } = {}): MarketDataProvider {
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.coinpaprika.com/v1";
  const id = (asset: CanonicalAsset) => {
    if (!isCanonicalAsset(asset)) throw new MarketError("UNKNOWN_ASSET", "Unsupported market asset");
    return COINPAPRIKA_IDS[asset];
  };
  async function get(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    try {
      const response = await doFetch(`${baseUrl.replace(/\/$/, "")}${path}`, { signal: controller.signal, headers: { accept: "application/json" } });
      if (response.status === 429) throw new MarketError("RATE_LIMIT", "Market provider rate limited");
      if (!response.ok) throw new MarketError("PROVIDER_ERROR", `Market provider HTTP ${response.status}`);
      try { return await response.json(); }
      catch { if (controller.signal.aborted) throw new MarketError("TIMEOUT", "Market response timed out");
        throw new MarketError("MALFORMED_RESPONSE", "Market response is not JSON"); }
    } catch (error) {
      if (error instanceof MarketError) throw error;
      throw new MarketError(controller.signal.aborted ? "TIMEOUT" : "PROVIDER_ERROR", "Market request unavailable");
    } finally { clearTimeout(timer); }
  }
  return {
    name: "coinpaprika",
    async getQuote(asset) {
      const coinId = id(asset);
      const data = object(await get(`/tickers/${coinId}`));
      if (data.id !== coinId || data.symbol !== asset) throw new MarketError("MALFORMED_RESPONSE", "Market identity mismatch");
      const usd = object(object(data.quotes).USD);
      const price = nonnegative(usd.price);
      if (price === null || price === 0) throw new MarketError("MALFORMED_RESPONSE", "Invalid market price");
      return { asset, provider: "coinpaprika", priceUsd: price, volume24hUsd: nonnegative(usd.volume_24h),
        marketCapUsd: nonnegative(usd.market_cap),
        percentChange24h: typeof usd.percent_change_24h === "number" && Number.isFinite(usd.percent_change_24h) ? usd.percent_change_24h : null,
        freshness: assessFreshness(typeof data.last_updated === "string" ? data.last_updated : null, now()) };
    },
    async getHistory(asset, days) {
      const coinId = id(asset);
      if (!Number.isFinite(days) || days <= 0) throw new MarketError("MALFORMED_RESPONSE", "Invalid history window");
      const end = now();
      // Free provider exposes intraday history. Keep the bound explicit even if a caller asks for more.
      const start = new Date(end.getTime() - Math.min(days, 1) * 86_400_000 + 60_000);
      const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), interval: "1h", limit: "24" });
      const data = await get(`/tickers/${coinId}/historical?${query}`);
      if (!Array.isArray(data) || data.length > MAX_HISTORY_POINTS) throw new MarketError("MALFORMED_RESPONSE", "Invalid history response");
      const history = normalizeHistory(data.map((value) => {
        const point = object(value);
        return { timestamp: typeof point.timestamp === "string" ? point.timestamp : "", priceUsd: nonnegative(point.price) ?? 0, volumeUsd: nonnegative(point.volume_24h) };
      })).filter((p) => Date.parse(p.timestamp) >= start.getTime() && Date.parse(p.timestamp) <= end.getTime()).slice(-24);
      if (history.length === 0) throw new MarketError("MALFORMED_RESPONSE", "No usable market history");
      return history;
    }
  };
}
