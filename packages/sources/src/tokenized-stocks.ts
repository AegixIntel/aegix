/**
 * Tokenized equities on Solana, read from chain state over plain JSON-RPC.
 *
 * Two series per token:
 *
 * - price_usdc: the spot price in the token's Raydium CLMM pool against USDC,
 *   decoded from the pool account's sqrt price.
 * - supply: tokens outstanding, from the Token-2022 mint. It moves when the
 *   issuer mints or redeems, which is on-chain flow, not trading.
 *
 * What these are, and are not. The price is the price of the *token* in one
 * on-chain pool. It tracks the underlying equity only as well as arbitrage
 * keeps it there, it trades when the stock market is closed, and one large
 * swap moves it. It is never presented as the underlying's exchange price.
 *
 * Every mapping below was read from mainnet, not assumed: the mint's own
 * Token-2022 metadata carries the symbol, and the pool account names both
 * mints. `collect` re-checks the pool identity on every read and drops the
 * price if it no longer holds, rather than decoding an account it cannot
 * identify. `scripts/verify-tokenized-stocks.ts` re-verifies the registry.
 */

import bs58 from "bs58";
import type { SeriesDescriptor } from "@aegix/rewind";
import { SourceError, fetchJson, type SeriesObservation, type SeriesSource } from "./types.js";

export const TOKENIZED_STOCK_SOURCE = "solana-rpc";
export const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
/** Mint authority shared by every token in the registry; a different one is a different issuer. */
export const XSTOCKS_MINT_AUTHORITY = "7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj";

/** Raydium CLMM PoolState layout (Anchor): the fields this source reads. */
const POOL_MINT_0_OFFSET = 73;
const POOL_MINT_1_OFFSET = 105;
const POOL_DECIMALS_0_OFFSET = 233;
const POOL_DECIMALS_1_OFFSET = 234;
const POOL_SQRT_PRICE_OFFSET = 253;
const POOL_MIN_LENGTH = POOL_SQRT_PRICE_OFFSET + 16;

export interface TokenizedStock {
  /** On-chain symbol from the mint's Token-2022 metadata. */
  symbol: string;
  /** What the issuer says the token tracks. A label, not a verified claim about backing. */
  underlying: string;
  mint: string;
  decimals: number;
  /** Raydium CLMM pool against USDC. Absent means no price series. */
  pool?: string;
}

export const TOKENIZED_STOCKS: readonly TokenizedStock[] = [
  { symbol: "TSLAx", underlying: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8, pool: "8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF" },
  { symbol: "NVDAx", underlying: "NVIDIA", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, pool: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6" },
  { symbol: "SPYx", underlying: "S&P 500 ETF", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8, pool: "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE" },
  { symbol: "AAPLx", underlying: "Apple", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, pool: "CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y" },
  { symbol: "QQQx", underlying: "Nasdaq 100 ETF", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", decimals: 8, pool: "GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG" },
  { symbol: "GOOGLx", underlying: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", decimals: 8, pool: "B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw" },
  { symbol: "MSTRx", underlying: "MicroStrategy", mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", decimals: 8, pool: "RyhF4cksVZY7vcqJpoytHcxcGNKRp27PEGhSnEPpbGv" },
  { symbol: "COINx", underlying: "Coinbase", mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", decimals: 8, pool: "w7SGmPeXoMCsjvXqgsAmUn56uypyDsjAtsxeVkaiqxa" },
  { symbol: "CRCLx", underlying: "Circle", mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", decimals: 8, pool: "GYqHjuDzTiw7i52Xv1qohDE6eJr6eSZpsrBVikGZyaFV" },
  { symbol: "HOODx", underlying: "Robinhood", mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", decimals: 8, pool: "DXWbip5LducMAbDSSpLYz9Xik3253EPeAYQufQtx7LXs" },
  { symbol: "METAx", underlying: "Meta", mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", decimals: 8, pool: "3L7KbPVaAQA4UTecaGQYsm6UCq5F3sZM9zAYkxqYt63j" },
  { symbol: "AMZNx", underlying: "Amazon", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", decimals: 8, pool: "6m5aXAve4uh6Kt4ytKyCLWNMjd8PYP5vujwNCtycrUiD" },
  { symbol: "MSFTx", underlying: "Microsoft", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", decimals: 8, pool: "CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL" },
  { symbol: "GLDx", underlying: "Gold ETF", mint: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re", decimals: 8, pool: "78ReVNMLGRWmjtf2HmBoHUe2pRcsctXTTbxJnbhchyze" }
];

export function isTokenizedStockSymbol(value: string): boolean {
  return TOKENIZED_STOCKS.some((s) => s.symbol === value);
}

export function tokenizedStockSeriesKey(symbol: string, metric: "price_usdc" | "supply"): string {
  return `xstock:${symbol}:${metric}`;
}

export function tokenizedStockSeries(stocks: readonly TokenizedStock[] = TOKENIZED_STOCKS): SeriesDescriptor[] {
  return stocks.flatMap((s) => [
    ...(s.pool ? [{ key: tokenizedStockSeriesKey(s.symbol, "price_usdc"), label: `${s.symbol} on-chain price (USDC)`, group: s.symbol }] : []),
    { key: tokenizedStockSeriesKey(s.symbol, "supply"), label: `${s.symbol} on-chain supply`, group: s.symbol }
  ]);
}

function sameBytes(data: Uint8Array, offset: number, expected: Uint8Array): boolean {
  for (let i = 0; i < expected.length; i++) if (data[offset + i] !== expected[i]) return false;
  return true;
}

/**
 * Decodes the USDC price of `stockMint` from a Raydium CLMM pool account.
 *
 * Returns null — never a guess — when the account is not the pool the
 * registry says it is: wrong owner, too short, or not this exact mint pair.
 */
export function decodeClmmPoolPrice(account: { owner: string; data: Uint8Array }, stockMint: string, stockDecimals: number): number | null {
  if (account.owner !== RAYDIUM_CLMM_PROGRAM || account.data.length < POOL_MIN_LENGTH) return null;
  const data = account.data;
  const stock = bs58.decode(stockMint);
  const usdc = bs58.decode(USDC_MINT);
  const stockIsToken0 = sameBytes(data, POOL_MINT_0_OFFSET, stock) && sameBytes(data, POOL_MINT_1_OFFSET, usdc);
  const stockIsToken1 = sameBytes(data, POOL_MINT_0_OFFSET, usdc) && sameBytes(data, POOL_MINT_1_OFFSET, stock);
  if (!stockIsToken0 && !stockIsToken1) return null;
  const decimals0 = data[POOL_DECIMALS_0_OFFSET]!;
  const decimals1 = data[POOL_DECIMALS_1_OFFSET]!;
  if (decimals0 !== (stockIsToken0 ? stockDecimals : USDC_DECIMALS) || decimals1 !== (stockIsToken0 ? USDC_DECIMALS : stockDecimals)) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sqrtPriceX64 = view.getBigUint64(POOL_SQRT_PRICE_OFFSET, true) + (view.getBigUint64(POOL_SQRT_PRICE_OFFSET + 8, true) << 64n);
  if (sqrtPriceX64 === 0n) return null;
  // token1 per token0, in whole-token units.
  const token1PerToken0 = (Number(sqrtPriceX64) / 2 ** 64) ** 2 * 10 ** (decimals0 - decimals1);
  const price = stockIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
  return Number.isFinite(price) && price > 0 ? price : null;
}

interface RpcAccount { owner: string; data: unknown }

export function createTokenizedStockSource(options: {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  stocks?: readonly TokenizedStock[];
}): SeriesSource {
  const stocks = options.stocks ?? TOKENIZED_STOCKS;

  async function getMultipleAccounts(addresses: string[], encoding: "base64" | "jsonParsed"): Promise<Array<RpcAccount | null>> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding, commitment: "finalized" }] });
    const response = await fetchJson(options.rpcUrl, { method: "POST", body, headers: { "content-type": "application/json" }, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs }) as
      { result?: { value?: unknown }; error?: { code?: number } };
    if (response.error) throw new SourceError(response.error.code === 429 ? "RATE_LIMIT" : "PROVIDER_ERROR", "Solana RPC returned an error");
    const value = response.result?.value;
    if (!Array.isArray(value) || value.length !== addresses.length) throw new SourceError("MALFORMED_RESPONSE", "Unexpected getMultipleAccounts shape");
    return value as Array<RpcAccount | null>;
  }

  return {
    name: TOKENIZED_STOCK_SOURCE,
    series: tokenizedStockSeries(stocks),
    async collect(at) {
      const eventTime = at.toISOString();
      const observations: SeriesObservation[] = [];
      const priced = stocks.filter((s) => s.pool);
      // Two calls for the whole registry: mints for supply, pools for price.
      const [mints, pools] = await Promise.all([
        getMultipleAccounts(stocks.map((s) => s.mint), "jsonParsed"),
        priced.length > 0 ? getMultipleAccounts(priced.map((s) => s.pool!), "base64") : Promise.resolve([])
      ]);

      stocks.forEach((stock, index) => {
        const account = mints[index];
        const info = (account?.data as { parsed?: { type?: string; info?: { supply?: string; decimals?: number; mintAuthority?: string | null } } } | undefined)?.parsed;
        // The mint must still be the token the registry describes.
        if (!account || account.owner !== TOKEN_2022_PROGRAM || info?.type !== "mint" || info.info?.decimals !== stock.decimals ||
          info.info.mintAuthority !== XSTOCKS_MINT_AUTHORITY || typeof info.info.supply !== "string" || !/^\d+$/.test(info.info.supply)) return;
        const supply = Number(BigInt(info.info.supply)) / 10 ** stock.decimals;
        if (supply > 0) observations.push({ seriesKey: tokenizedStockSeriesKey(stock.symbol, "supply"), eventTime, value: supply, source: TOKENIZED_STOCK_SOURCE });
      });

      priced.forEach((stock, index) => {
        const account = pools[index];
        const encoded = Array.isArray(account?.data) && account.data[1] === "base64" && typeof account.data[0] === "string" ? account.data[0] : null;
        if (!account || encoded === null) return;
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        const price = decodeClmmPoolPrice({ owner: account.owner, data: bytes }, stock.mint, stock.decimals);
        if (price !== null) observations.push({ seriesKey: tokenizedStockSeriesKey(stock.symbol, "price_usdc"), eventTime, value: price, source: `${TOKENIZED_STOCK_SOURCE}:raydium-clmm` });
      });
      return observations;
    }
  };
}
