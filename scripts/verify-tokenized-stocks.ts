/**
 * Verifies the tokenized stock registry against Solana mainnet.
 *
 * The registry maps a symbol to a mint and a pool. A wrong mapping would
 * publish one token's price under another's name, so nothing in it is taken
 * on trust: for every entry this reads the mint's own Token-2022 metadata and
 * the pool account, and fails unless they say what the registry says.
 *
 * Needs a live RPC (RPC_URL), so it runs on the VPS:
 *   pnpm verify:tokenized-stocks
 */

import { loadConfig } from "@aegix/config";
import {
  TOKENIZED_STOCKS, TOKEN_2022_PROGRAM, XSTOCKS_MINT_AUTHORITY, decodeClmmPoolPrice
} from "../packages/sources/src/index.js";

interface ParsedMint {
  owner: string;
  data: { parsed?: { type?: string; info?: { decimals?: number; mintAuthority?: string | null;
    extensions?: Array<{ extension: string; state?: { symbol?: string } }> } } };
}

async function rpc<T>(url: string, addresses: string[], encoding: "jsonParsed" | "base64"): Promise<Array<T | null>> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding, commitment: "finalized" }] }) });
  const body = await response.json() as { result?: { value: Array<T | null> }; error?: { message?: string } };
  if (!body.result) throw new Error(`RPC error: ${body.error?.message ?? response.status}`);
  return body.result.value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const priced = TOKENIZED_STOCKS.filter((s) => s.pool);
  const mints = await rpc<ParsedMint>(config.RPC_URL, TOKENIZED_STOCKS.map((s) => s.mint), "jsonParsed");
  const pools = await rpc<{ owner: string; data: [string, string] }>(config.RPC_URL, priced.map((s) => s.pool!), "base64");
  const failures: string[] = [];

  TOKENIZED_STOCKS.forEach((stock, index) => {
    const account = mints[index];
    const info = account?.data.parsed?.info;
    const symbol = info?.extensions?.find((e) => e.extension === "tokenMetadata")?.state?.symbol;
    if (!account) failures.push(`${stock.symbol}: mint account does not exist`);
    else if (account.owner !== TOKEN_2022_PROGRAM) failures.push(`${stock.symbol}: mint is owned by ${account.owner}`);
    else if (symbol !== stock.symbol) failures.push(`${stock.symbol}: on-chain metadata symbol is ${symbol ?? "absent"}`);
    else if (info?.decimals !== stock.decimals) failures.push(`${stock.symbol}: on-chain decimals are ${info?.decimals}`);
    else if (info.mintAuthority !== XSTOCKS_MINT_AUTHORITY) failures.push(`${stock.symbol}: mint authority is ${info.mintAuthority}`);
  });

  priced.forEach((stock, index) => {
    const account = pools[index];
    if (!account) { failures.push(`${stock.symbol}: pool account does not exist`); return; }
    const price = decodeClmmPoolPrice({ owner: account.owner, data: Uint8Array.from(Buffer.from(account.data[0], "base64")) }, stock.mint, stock.decimals);
    if (price === null) failures.push(`${stock.symbol}: pool ${stock.pool} is not a Raydium CLMM ${stock.symbol}/USDC pool`);
    else console.log(`${stock.symbol.padEnd(7)} ${price.toFixed(4)} USDC`);
  });

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
    return;
  }
  console.log(`${TOKENIZED_STOCKS.length} mints and ${priced.length} pools verified on-chain`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "verification failed"); process.exitCode = 1; });
