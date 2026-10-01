/**
 * Writes provider history for the Discovery Engine's series to a CSV, to be
 * loaded into observation_points once.
 *
 * The Discovery Engine needs 14 days of hourly observations before it can
 * test anything. This reads those days from providers that publish history,
 * instead of waiting for the ledger to accumulate them:
 *
 * - BTC, ETH, SOL price and rolling 24h volume: CoinGecko market_chart.
 * - Tokenized stock price: GeckoTerminal hourly candles of the same Raydium
 *   CLMM pool the live source reads. A pool whose mints are not the registry's
 *   stock mint and USDC is skipped, never assumed.
 *
 * What it deliberately leaves alone:
 *
 * - Rewind. Replays read signal captures, which this does not write, and the
 *   tokenized stock cutoff keeps every backfilled hour older than the 25 hours
 *   of ledger a capture reads.
 * - The seam. Each series stops at least one whole hour before its first live
 *   observation, so no hourly change is computed across two providers.
 * - observed_at. The ledger stamps it at load time, so a backfilled row is
 *   always recognisable: it was observed long after its event time.
 *
 * Supply, narrative and options have no history to read and are not written.
 *
 *   node --import tsx scripts/backfill-discovery-history.ts \
 *     --from 2026-09-16T00:00:00Z --market-before 2026-09-30T09:00:00Z \
 *     --xstock-before 2026-09-30T21:00:00Z --out backfill.csv --overlap overlap.csv
 */

import { writeFileSync } from "node:fs";
import { CANONICAL_ASSETS } from "../packages/markets/src/index.js";
import { marketSeriesKey } from "../packages/rewind/src/index.js";
import { TOKENIZED_STOCKS, USDC_MINT, tokenizedStockSeriesKey } from "../packages/sources/src/index.js";

export const MARKET_BACKFILL_SOURCE = "coingecko";
export const XSTOCK_BACKFILL_SOURCE = "geckoterminal:raydium-clmm";

const COINGECKO_IDS: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
const HOUR_MS = 3_600_000;
/** GeckoTerminal refused the eighth request of a run spaced 2.5 seconds apart. */
const GECKOTERMINAL_SPACING_MS = 7_000;
const RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_WAIT_MS = 30_000;

interface Row { seriesKey: string; eventTime: string; value: number; source: string }

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function time(name: string): number {
  const ms = Date.parse(arg(name));
  if (!Number.isFinite(ms) || ms % HOUR_MS !== 0) throw new Error(`--${name} must be a whole UTC hour`);
  return ms;
}

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
    if (response.ok) return response.json();
    if (response.status !== 429 || attempt === RATE_LIMIT_ATTEMPTS) throw new Error(`${new URL(url).host} HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
  }
}

async function marketRows(asset: string, fromMs: number): Promise<Row[]> {
  // CoinGecko answers hourly for ranges between 2 and 90 days.
  const days = Math.min(90, Math.ceil((Date.now() - fromMs) / (24 * HOUR_MS)) + 1);
  const body = await getJson(`https://api.coingecko.com/api/v3/coins/${COINGECKO_IDS[asset]}/market_chart?vs_currency=usd&days=${days}`) as
    { prices?: Array<[number, number]>; total_volumes?: Array<[number, number]> };
  if (!Array.isArray(body.prices) || !Array.isArray(body.total_volumes)) throw new Error(`CoinGecko ${asset}: malformed response`);
  const rows = (points: Array<[number, number]>, metric: "price_usd" | "volume_24h_usd"): Row[] => points
    .filter(([at, value]) => Number.isFinite(at) && Number.isFinite(value) && value > 0)
    .map(([at, value]) => ({ seriesKey: marketSeriesKey(asset, metric), eventTime: new Date(at).toISOString(), value, source: MARKET_BACKFILL_SOURCE }));
  return [...rows(body.prices, "price_usd"), ...rows(body.total_volumes, "volume_24h_usd")];
}

async function xstockRows(stock: { symbol: string; mint: string; pool?: string }, fromMs: number): Promise<Row[]> {
  const hours = Math.min(1000, Math.ceil((Date.now() - fromMs) / HOUR_MS) + 2);
  const body = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${stock.pool}/ohlcv/hour?aggregate=1&limit=${hours}&currency=token`) as {
    data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
    meta?: { base?: { address?: string }; quote?: { address?: string } };
  };
  // The candles are priced in the quote token, so the pair must be exactly
  // this stock against USDC, in that order.
  if (body.meta?.base?.address !== stock.mint || body.meta?.quote?.address !== USDC_MINT) {
    throw new Error(`GeckoTerminal ${stock.symbol}: pool is not ${stock.symbol}/USDC`);
  }
  const candles = body.data?.attributes?.ohlcv_list;
  if (!Array.isArray(candles)) throw new Error(`GeckoTerminal ${stock.symbol}: malformed response`);
  return candles
    .filter(([start, , , , close]) => Number.isFinite(start) && Number.isFinite(close) && close > 0)
    // The close is the pool price at the end of the candle's hour, which is
    // where the live source's last reading of an hour sits.
    .map(([start, , , , close]) => ({ seriesKey: tokenizedStockSeriesKey(stock.symbol, "price_usdc"),
      eventTime: new Date(start * 1000 + HOUR_MS - 1000).toISOString(), value: close, source: XSTOCK_BACKFILL_SOURCE }));
}

function csv(rows: Row[]): string {
  return rows.map((r) => `${r.seriesKey},${r.eventTime},${r.value},${r.source}`).join("\n") + "\n";
}

async function main(): Promise<void> {
  const fromMs = time("from");
  const marketBeforeMs = time("market-before");
  const xstockBeforeMs = time("xstock-before");
  const kept: Row[] = [];
  const overlap: Row[] = [];
  const failures: string[] = [];

  const take = (rows: Row[], beforeMs: number) => {
    for (const row of rows) {
      const at = Date.parse(row.eventTime);
      if (at < fromMs) continue;
      (at < beforeMs ? kept : overlap).push(row);
    }
  };

  for (const asset of CANONICAL_ASSETS) {
    try { take(await marketRows(asset, fromMs), marketBeforeMs); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  for (const stock of TOKENIZED_STOCKS.filter((s) => s.pool)) {
    try { take(await xstockRows(stock, fromMs), xstockBeforeMs); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    await new Promise((resolve) => setTimeout(resolve, GECKOTERMINAL_SPACING_MS));
  }

  const sort = (rows: Row[]) => rows.sort((a, b) => a.seriesKey.localeCompare(b.seriesKey) || a.eventTime.localeCompare(b.eventTime));
  writeFileSync(arg("out"), csv(sort(kept)));
  // Hours the ledger already holds from the live sources: written separately,
  // to compare the two providers, and never loaded.
  writeFileSync(arg("overlap"), csv(sort(overlap)));

  const perSeries = new Map<string, number>();
  for (const row of kept) perSeries.set(row.seriesKey, (perSeries.get(row.seriesKey) ?? 0) + 1);
  for (const [key, count] of [...perSeries].sort()) console.log(`${key} ${count}`);
  console.log(`rows ${kept.length}, overlap ${overlap.length}, failures ${failures.length}`);
  for (const failure of failures) console.error(`FAILED ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "backfill failed"); process.exitCode = 1; });
