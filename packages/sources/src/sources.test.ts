import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import {
  RAYDIUM_CLMM_PROGRAM, TOKENIZED_STOCKS, TOKEN_2022_PROGRAM, USDC_MINT, XSTOCKS_MINT_AUTHORITY,
  createTokenizedStockSource, decodeClmmPoolPrice, isTokenizedStockSymbol, tokenizedStockSeries, type TokenizedStock
} from "./tokenized-stocks.js";
import { NARRATIVE_TOPICS, createNarrativeSource, hourlyNarrativeVolume, narrativeSeries } from "./narrative.js";
import { aggregateOptionsChain, createOptionsSource, optionsSeries } from "./options.js";
import { SourceError } from "./types.js";

const NVDA = TOKENIZED_STOCKS.find((s) => s.symbol === "NVDAx")!;
const AT = new Date("2026-10-01T04:15:00.000Z");

/** A Raydium CLMM pool account with only the fields the decoder reads. */
function poolAccount(mint0: string, mint1: string, decimals0: number, decimals1: number, price1Per0: number): Uint8Array {
  const data = new Uint8Array(1544);
  data.set(bs58.decode(mint0), 73);
  data.set(bs58.decode(mint1), 105);
  data[233] = decimals0; data[234] = decimals1;
  const sqrt = BigInt(Math.round(Math.sqrt(price1Per0 / 10 ** (decimals0 - decimals1)) * 2 ** 64));
  const view = new DataView(data.buffer);
  view.setBigUint64(253, sqrt & 0xffffffffffffffffn, true);
  view.setBigUint64(261, sqrt >> 64n, true);
  return data;
}
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) / expected < 1e-9, `${actual} ≈ ${expected}`);

test("the registry is internally consistent", () => {
  assert.equal(new Set(TOKENIZED_STOCKS.map((s) => s.symbol)).size, TOKENIZED_STOCKS.length);
  assert.equal(new Set(TOKENIZED_STOCKS.map((s) => s.mint)).size, TOKENIZED_STOCKS.length);
  const pools = TOKENIZED_STOCKS.flatMap((s) => (s.pool ? [s.pool] : []));
  assert.equal(new Set(pools).size, pools.length);
  for (const s of TOKENIZED_STOCKS) {
    assert.equal(bs58.decode(s.mint).length, 32, `${s.symbol} mint is a public key`);
    if (s.pool) assert.equal(bs58.decode(s.pool).length, 32, `${s.symbol} pool is a public key`);
  }
  assert.ok(isTokenizedStockSymbol("NVDAx"));
  assert.ok(!isTokenizedStockSymbol("NVDA"));
  assert.equal(tokenizedStockSeries([NVDA]).length, 2);
  assert.equal(tokenizedStockSeries([{ ...NVDA, pool: undefined }]).length, 1, "no pool, no price series");
});

test("pool price decodes in either token order", () => {
  close(decodeClmmPoolPrice({ owner: RAYDIUM_CLMM_PROGRAM, data: poolAccount(NVDA.mint, USDC_MINT, 8, 6, 230.58) }, NVDA.mint, 8), 230.58);
  close(decodeClmmPoolPrice({ owner: RAYDIUM_CLMM_PROGRAM, data: poolAccount(USDC_MINT, NVDA.mint, 6, 8, 1 / 230.58) }, NVDA.mint, 8), 230.58);
});

test("an account that is not the registered pool yields no price", () => {
  const good = poolAccount(NVDA.mint, USDC_MINT, 8, 6, 230.58);
  const tsla = TOKENIZED_STOCKS.find((s) => s.symbol === "TSLAx")!;
  assert.equal(decodeClmmPoolPrice({ owner: TOKEN_2022_PROGRAM, data: good }, NVDA.mint, 8), null, "wrong owner program");
  assert.equal(decodeClmmPoolPrice({ owner: RAYDIUM_CLMM_PROGRAM, data: good }, tsla.mint, 8), null, "a different token's pool");
  assert.equal(decodeClmmPoolPrice({ owner: RAYDIUM_CLMM_PROGRAM, data: poolAccount(NVDA.mint, tsla.mint, 8, 8, 1) }, NVDA.mint, 8), null, "not quoted in USDC");
  assert.equal(decodeClmmPoolPrice({ owner: RAYDIUM_CLMM_PROGRAM, data: poolAccount(NVDA.mint, USDC_MINT, 9, 6, 230.58) }, NVDA.mint, 8), null, "unexpected decimals");
  assert.equal(decodeClmmPoolPrice({ owner: RAYDIUM_CLMM_PROGRAM, data: good.subarray(0, 200) }, NVDA.mint, 8), null, "truncated account");
  assert.equal(decodeClmmPoolPrice({ owner: RAYDIUM_CLMM_PROGRAM, data: poolAccount(NVDA.mint, USDC_MINT, 8, 6, 0) }, NVDA.mint, 8), null, "zero price");
});

function rpcFetch(handlers: { mints: unknown[]; pools: unknown[] }): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as { params: [string[], { encoding: string }] };
    calls.push(request.params[1].encoding);
    const value = request.params[1].encoding === "jsonParsed" ? handlers.mints : handlers.pools;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const mintAccount = (overrides: Record<string, unknown> = {}, owner = TOKEN_2022_PROGRAM) => ({ owner,
  data: { parsed: { type: "mint", info: { supply: "32126896385426", decimals: 8, mintAuthority: XSTOCKS_MINT_AUTHORITY, ...overrides } } } });

test("the source reads supply and price in two RPC calls", async () => {
  const stocks: TokenizedStock[] = [NVDA];
  const { fetchImpl, calls } = rpcFetch({ mints: [mintAccount()],
    pools: [{ owner: RAYDIUM_CLMM_PROGRAM, data: [base64(poolAccount(NVDA.mint, USDC_MINT, 8, 6, 230.58)), "base64"] }] });
  const observations = await createTokenizedStockSource({ rpcUrl: "http://rpc.test", fetchImpl, stocks }).collect(AT);
  assert.deepEqual(calls.sort(), ["base64", "jsonParsed"]);
  const supply = observations.find((o) => o.seriesKey === "xstock:NVDAx:supply")!;
  const price = observations.find((o) => o.seriesKey === "xstock:NVDAx:price_usdc")!;
  assert.equal(supply.value, 321268.96385426);
  assert.equal(supply.eventTime, AT.toISOString());
  close(price.value, 230.58);
  assert.equal(price.source, "solana-rpc:raydium-clmm");
});

test("a mint or pool that fails its identity check leaves a gap instead of a value", async () => {
  const cases: Array<{ mints: unknown[]; pools: unknown[]; expect: string[] }> = [
    { mints: [mintAccount({ mintAuthority: "11111111111111111111111111111111" })], pools: [null], expect: [] },
    { mints: [mintAccount({ decimals: 6 })], pools: [null], expect: [] },
    { mints: [mintAccount({}, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")], pools: [null], expect: [] },
    { mints: [null], pools: [{ owner: TOKEN_2022_PROGRAM, data: [base64(poolAccount(NVDA.mint, USDC_MINT, 8, 6, 230.58)), "base64"] }], expect: [] },
    { mints: [mintAccount()], pools: [null], expect: ["xstock:NVDAx:supply"] }
  ];
  for (const c of cases) {
    const { fetchImpl } = rpcFetch(c);
    const observations = await createTokenizedStockSource({ rpcUrl: "http://rpc.test", fetchImpl, stocks: [NVDA] }).collect(AT);
    assert.deepEqual(observations.map((o) => o.seriesKey), c.expect);
  }
});

test("an RPC error is an error, not an empty reading", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests" } }), { status: 200 })) as typeof fetch;
  await assert.rejects(createTokenizedStockSource({ rpcUrl: "http://rpc.test", fetchImpl, stocks: [NVDA] }).collect(AT),
    (e) => e instanceof SourceError && e.code === "RATE_LIMIT");
});

const gdelt = (points: Array<[string, number]>) => ({ query_details: { title: "x", date_resolution: "15m" },
  timeline: [{ series: "Volume Intensity", data: points.map(([date, value]) => ({ date, value })) }] });

test("narrative volume is averaged per completed hour", () => {
  const hours = hourlyNarrativeVolume(gdelt([
    ["20261001T020000Z", 0.2], ["20261001T021500Z", 0.4], ["20261001T030000Z", 0.6],
    ["20261001T040000Z", 9], ["20261001T041500Z", 9], ["bad", 1]
  ]), AT);
  assert.equal(hours.length, 2, "the hour still in progress is left out");
  assert.equal(hours[0]!.eventTime, "2026-10-01T02:00:00.000Z");
  assert.ok(Math.abs(hours[0]!.value - 0.3) < 1e-12);
  assert.equal(hours[1]!.value, 0.6);
  assert.throws(() => hourlyNarrativeVolume({ timeline: [] }, AT), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
});

test("the narrative source spaces its requests and retries a refused topic", async () => {
  const topics = NARRATIVE_TOPICS.slice(0, 3);
  const sleeps: number[] = [];
  let request = 0;
  const fetchImpl = (async () => {
    request += 1;
    if (request === 2 || request === 3) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify(gdelt([["20261001T020000Z", 0.5]])), { status: 200 });
  }) as typeof fetch;
  const failures: string[] = [];
  const source = createNarrativeSource({ topics, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, onTopicFailure: (id) => failures.push(id) });
  const observations = await source.collect(AT);
  assert.equal(request, 5, "the refused topic is asked again until it answers");
  assert.deepEqual(sleeps, [10_000, 30_000, 50_000, 10_000], "every request waits, and each retry waits longer");
  assert.deepEqual(observations.map((o) => o.seriesKey), topics.map((t) => `narrative:${t.id}:news_volume_share`));
  assert.deepEqual(failures, []);
  assert.equal(narrativeSeries(topics).length, 3);
});

test("a topic that never answers is reported and left as a gap", async () => {
  const topics = NARRATIVE_TOPICS.slice(0, 2);
  const reported: Array<[string, string, number]> = [];
  let request = 0;
  const refused = new URLSearchParams({ query: topics[0]!.query }).toString();
  const fetchImpl = (async (url: unknown) => {
    request += 1;
    if (String(url).includes(refused)) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify(gdelt([["20261001T020000Z", 0.5]])), { status: 200 });
  }) as typeof fetch;
  const source = createNarrativeSource({ topics, fetchImpl, sleep: async () => {}, onTopicFailure: (id, code, attempts) => reported.push([id, code, attempts]) });
  const observations = await source.collect(AT);
  assert.deepEqual(reported, [[topics[0]!.id, "RATE_LIMIT", 5]]);
  assert.equal(request, 6);
  assert.deepEqual(observations.map((o) => o.seriesKey), [`narrative:${topics[1]!.id}:news_volume_share`]);

  let malformed = 0;
  const broken = createNarrativeSource({ topics: topics.slice(0, 1), sleep: async () => {},
    fetchImpl: (async () => { malformed += 1; return new Response(JSON.stringify({ timeline: "no" }), { status: 200 }); }) as typeof fetch });
  await assert.rejects(broken.collect(AT), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
  assert.equal(malformed, 1, "a malformed answer is not asked for again");

  const down = createNarrativeSource({ topics, sleep: async () => {}, fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch });
  await assert.rejects(down.collect(AT), (e) => e instanceof SourceError);
});

const chain = { timestamp: "2026-10-01 03:43:57", data: { options: [
  { option: "XLU261002C00025000", volume: 5, open_interest: 11 },
  { option: "XLU261002P00025000", volume: 20, open_interest: 9 },
  { option: "XLU1261002C00025000", volume: 999, open_interest: 999 },
  { option: "XLUV261002C00025000", volume: 999, open_interest: 999 },
  { option: "XLU261016C00040000", volume: "n/a", open_interest: 3 }
] } };

test("an options chain is summed only over this underlying's contracts", () => {
  assert.deepEqual(aggregateOptionsChain(chain, "XLU"), { contracts: 3, callVolume: 5, putVolume: 20, openInterest: 23 });
  assert.throws(() => aggregateOptionsChain(chain, "SPY"), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
  assert.throws(() => aggregateOptionsChain({ data: {} }, "XLU"), (e) => e instanceof SourceError);
});

test("the options source omits a ratio it cannot define", async () => {
  const respond = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  const full = await createOptionsSource({ underlyings: ["XLU"], fetchImpl: respond(chain) }).collect(AT);
  assert.deepEqual(Object.fromEntries(full.map((o) => [o.seriesKey, o.value])), {
    "options:XLU:call_volume": 5, "options:XLU:put_volume": 20, "options:XLU:open_interest": 23, "options:XLU:put_call_volume_ratio": 4 });
  const quiet = { data: { options: [{ option: "XLU261002C00025000", volume: 0, open_interest: 11 }] } };
  const partial = await createOptionsSource({ underlyings: ["XLU"], fetchImpl: respond(quiet) }).collect(AT);
  assert.deepEqual(partial.map((o) => o.seriesKey), ["options:XLU:open_interest"]);
  assert.equal(optionsSeries(["XLU"]).length, 2, "raw volume is stored but not scanned");
});
