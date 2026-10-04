/**
 * Listed-options activity from Cboe's delayed quotes.
 *
 * Per underlying, aggregated over the whole chain: call volume, put volume,
 * the put/call volume ratio and total open interest.
 *
 * Read this before enabling it:
 *
 * - The data is delayed and is the exchange's public website feed, not a
 *   licensed market-data product. It carries no redistribution licence, which
 *   is why this source has its own flag and is off by default.
 * - Volume is cumulative within a US session and frozen outside it, so the
 *   raw volume series are stored but not scanned. The ratio and open
 *   interest are.
 * - Options trade about 6.5 hours a day. The hourly Discovery Engine needs
 *   consecutive hours and records these series as INSUFFICIENT_DATA; the
 *   daily scan is what reads them.
 * - The feed keeps answering outside the session with the last session's
 *   totals. The chain is read only while the market is open, so a weekend is
 *   a gap in the ledger and not two days on which nothing changed. An
 *   exchange holiday on a weekday is still read, and stores the day before.
 */

import type { SeriesDescriptor } from "@aegix/rewind";
import { SourceError, fetchJson, type SeriesObservation, type SeriesSource } from "./types.js";
import { usEquitySessionOpen } from "./us-session.js";

export const OPTIONS_SOURCE = "cboe-delayed-quotes";

export const OPTIONS_UNDERLYINGS: readonly string[] = ["SPY", "QQQ", "XLU", "XLE", "NVDA", "TSLA"];

export type OptionsMetric = "call_volume" | "put_volume" | "put_call_volume_ratio" | "open_interest";

export function optionsSeriesKey(underlying: string, metric: OptionsMetric): string {
  return `options:${underlying}:${metric}`;
}

export function optionsSeries(underlyings: readonly string[] = OPTIONS_UNDERLYINGS): SeriesDescriptor[] {
  return underlyings.flatMap((u) => [
    { key: optionsSeriesKey(u, "put_call_volume_ratio"), label: `${u} options put/call volume ratio`, group: `options:${u}` },
    { key: optionsSeriesKey(u, "open_interest"), label: `${u} options open interest`, group: `options:${u}` }
  ]);
}

export interface OptionsAggregate { contracts: number; callVolume: number; putVolume: number; openInterest: number }

/**
 * Sums a chain. Only contracts whose OCC symbol starts with exactly this
 * underlying are counted, so an adjusted or unrelated root cannot be
 * attributed to it.
 */
export function aggregateOptionsChain(payload: unknown, underlying: string): OptionsAggregate {
  const options = (payload as { data?: { options?: unknown } } | null)?.data?.options;
  if (!Array.isArray(options)) throw new SourceError("MALFORMED_RESPONSE", "Options chain is missing");
  const occ = new RegExp(`^${underlying}\\d{6}([CP])\\d{8}$`);
  const total: OptionsAggregate = { contracts: 0, callVolume: 0, putVolume: 0, openInterest: 0 };
  for (const row of options as Array<{ option?: unknown; volume?: unknown; open_interest?: unknown }>) {
    const side = typeof row.option === "string" ? occ.exec(row.option)?.[1] : undefined;
    if (!side) continue;
    const volume = typeof row.volume === "number" && Number.isFinite(row.volume) && row.volume >= 0 ? row.volume : 0;
    const openInterest = typeof row.open_interest === "number" && Number.isFinite(row.open_interest) && row.open_interest >= 0 ? row.open_interest : 0;
    total.contracts += 1;
    if (side === "C") total.callVolume += volume; else total.putVolume += volume;
    total.openInterest += openInterest;
  }
  if (total.contracts === 0) throw new SourceError("MALFORMED_RESPONSE", `No ${underlying} contracts in the chain`);
  return total;
}

export function createOptionsSource(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  underlyings?: readonly string[];
} = {}): SeriesSource {
  const underlyings = options.underlyings ?? OPTIONS_UNDERLYINGS;
  const baseUrl = (options.baseUrl ?? "https://cdn.cboe.com/api/global").replace(/\/$/, "");

  return {
    name: OPTIONS_SOURCE,
    series: optionsSeries(underlyings),
    async collect(at) {
      if (!usEquitySessionOpen(at)) return [];
      const eventTime = at.toISOString();
      const observations: SeriesObservation[] = [];
      let failures = 0;
      for (const underlying of underlyings) {
        try {
          const payload = await fetchJson(`${baseUrl}/delayed_quotes/options/${underlying}.json`, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
          const chain = aggregateOptionsChain(payload, underlying);
          const add = (metric: OptionsMetric, value: number) => {
            if (value > 0) observations.push({ seriesKey: optionsSeriesKey(underlying, metric), eventTime, value, source: OPTIONS_SOURCE });
          };
          add("call_volume", chain.callVolume);
          add("put_volume", chain.putVolume);
          add("open_interest", chain.openInterest);
          // A ratio with an empty side is undefined, not zero or infinite.
          if (chain.callVolume > 0 && chain.putVolume > 0) add("put_call_volume_ratio", chain.putVolume / chain.callVolume);
        } catch (error) {
          failures += 1;
          if (failures === underlyings.length) throw error;
        }
      }
      return observations;
    }
  };
}
