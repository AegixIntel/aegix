/**
 * Sector and commodity prices from Cboe's delayed quotes.
 *
 * One series per exchange-traded fund: its last traded price in US dollars.
 * The eleven sector funds are what sector rotation is read from; the
 * commodity funds stand in for copper, uranium miners, gold and oil, which
 * AEGIX otherwise knows only as news topics.
 *
 * Read this before enabling it:
 *
 * - The data is delayed and is the exchange's public website feed, the same
 *   one the options source reads. It carries no redistribution licence, which
 *   is why this source has its own flag and is off by default.
 * - A fund's price is not the commodity's price. CPER holds copper futures,
 *   USO oil futures, GLD bullion, and URA shares of uranium miners. Each
 *   label says which fund it is, and nothing in the product calls it the
 *   spot price.
 * - Funds trade about 6.5 hours a day. The hourly Discovery Engine needs
 *   consecutive hours, so these series are read by the daily scan.
 */

import type { SeriesDescriptor } from "@aegix/rewind";
import { SourceError, fetchJson, type SeriesObservation, type SeriesSource } from "./types.js";
import { usEasternClock, usEquitySessionOpen } from "./us-session.js";

export const SECTOR_QUOTES_SOURCE = "cboe-delayed-equity-quotes";

export interface QuotedFund {
  symbol: string;
  /** What the fund holds, as the label will say it. */
  holds: string;
  group: string;
}

/**
 * The list is part of the hypothesis set: a fund is not added because its
 * sector is already in the news.
 */
export const QUOTED_FUNDS: readonly QuotedFund[] = [
  { symbol: "XLK", holds: "technology sector", group: "sector:technology" },
  { symbol: "XLF", holds: "financial sector", group: "sector:financials" },
  { symbol: "XLE", holds: "energy sector", group: "sector:energy" },
  { symbol: "XLU", holds: "utilities sector", group: "sector:utilities" },
  { symbol: "XLV", holds: "health care sector", group: "sector:health-care" },
  { symbol: "XLI", holds: "industrial sector", group: "sector:industrials" },
  { symbol: "XLY", holds: "consumer discretionary sector", group: "sector:consumer-discretionary" },
  { symbol: "XLP", holds: "consumer staples sector", group: "sector:consumer-staples" },
  { symbol: "XLB", holds: "materials sector", group: "sector:materials" },
  { symbol: "XLRE", holds: "real estate sector", group: "sector:real-estate" },
  { symbol: "XLC", holds: "communication services sector", group: "sector:communication-services" },
  { symbol: "SMH", holds: "semiconductor companies", group: "industry:semiconductors" },
  { symbol: "CPER", holds: "copper futures", group: "commodity:copper" },
  { symbol: "URA", holds: "uranium miners", group: "commodity:uranium" },
  { symbol: "GLD", holds: "gold bullion", group: "commodity:gold" },
  { symbol: "USO", holds: "oil futures", group: "commodity:oil" }
];

export function fundPriceSeriesKey(symbol: string): string {
  return `fund:${symbol}:price_usd`;
}

export function sectorQuoteSeries(funds: readonly QuotedFund[] = QUOTED_FUNDS): SeriesDescriptor[] {
  return funds.map((f) => ({ key: fundPriceSeriesKey(f.symbol), label: `${f.symbol} fund price (${f.holds})`, group: f.group }));
}

/**
 * The fund's last price, or null when its last trade was not today in New
 * York: the exchange is closed for a holiday, or the fund did not trade, and
 * yesterday's price is not today's observation.
 */
export function fundPrice(payload: unknown, symbol: string, at: Date): number | null {
  const data = (payload as { data?: { symbol?: unknown; current_price?: unknown; last_trade_time?: unknown } } | null)?.data;
  if (!data || typeof data !== "object") throw new SourceError("MALFORMED_RESPONSE", "Quote is missing");
  // The answer names its own symbol; a quote for anything else is not this fund's.
  if (data.symbol !== symbol) throw new SourceError("MALFORMED_RESPONSE", `Quote is not for ${symbol}`);
  const price = data.current_price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new SourceError("MALFORMED_RESPONSE", `No price for ${symbol}`);
  // "2026-10-02T15:59:59", exchange time with no offset.
  const tradedOn = typeof data.last_trade_time === "string" ? /^(\d{4}-\d{2}-\d{2})T/.exec(data.last_trade_time)?.[1] : undefined;
  if (!tradedOn) throw new SourceError("MALFORMED_RESPONSE", `No trade time for ${symbol}`);
  return tradedOn === usEasternClock(at).date ? price : null;
}

export function createSectorQuoteSource(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  funds?: readonly QuotedFund[];
} = {}): SeriesSource {
  const funds = options.funds ?? QUOTED_FUNDS;
  const baseUrl = (options.baseUrl ?? "https://cdn.cboe.com/api/global").replace(/\/$/, "");

  return {
    name: SECTOR_QUOTES_SOURCE,
    series: sectorQuoteSeries(funds),
    async collect(at) {
      if (!usEquitySessionOpen(at)) return [];
      const eventTime = at.toISOString();
      const observations: SeriesObservation[] = [];
      let failures = 0;
      for (const fund of funds) {
        try {
          const payload = await fetchJson(`${baseUrl}/delayed_quotes/quotes/${fund.symbol}.json`, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
          const price = fundPrice(payload, fund.symbol, at);
          if (price !== null) observations.push({ seriesKey: fundPriceSeriesKey(fund.symbol), eventTime, value: price, source: SECTOR_QUOTES_SOURCE });
        } catch (error) {
          failures += 1;
          if (failures === funds.length) throw error;
        }
      }
      return observations;
    }
  };
}
