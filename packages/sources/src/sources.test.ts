import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import {
  RAYDIUM_CLMM_PROGRAM, TOKENIZED_STOCKS, TOKEN_2022_PROGRAM, USDC_MINT, XSTOCKS_MINT_AUTHORITY,
  createTokenizedStockSource, decodeClmmPoolPrice, isTokenizedStockSymbol, tokenizedStockSeries, type TokenizedStock
} from "./tokenized-stocks.js";
import { GDELT_MAX_ATTEMPTS, GDELT_RETRY_WAIT_MS, GDELT_TIMEOUT_MS, NARRATIVE_ROTATION_MS, NARRATIVE_TOPICS, createNarrativeSource, hourlyNarrativeVolume, isEmptyGdeltTimeline, narrativeSeries, narrativeTopicFor } from "./narrative.js";
import {
  CONTEXT_HOURS_PER_SWEEP, CONTEXT_MAX_RECORDS, CONTEXT_REQUEST_GAP_MS, NARRATIVE_CONTEXT_SOURCE,
  contextMentionCount, createNarrativeContextSource, narrativeContextSeries
} from "./narrative-context.js";
import { aggregateOptionsChain, createOptionsSource, optionsSeries } from "./options.js";
import { QUOTED_FUNDS, SECTOR_QUOTES_SOURCE, createSectorQuoteSource, fundPrice, sectorQuoteSeries } from "./sector-quotes.js";
import { usEasternClock, usEquitySessionOpen } from "./us-session.js";
import { SourceError } from "./types.js";

const NVDA = TOKENIZED_STOCKS.find((s) => s.symbol === "NVDAx")!;
const AT = new Date("2026-10-01T04:15:00.000Z");
/** A Thursday at 11:15 in New York: the US session is open. */
const SESSION = new Date("2026-10-01T15:15:00.000Z");

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
  assert.throws(() => hourlyNarrativeVolume({ timeline: [{ series: "Volume Intensity" }] }, AT), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
  assert.throws(() => hourlyNarrativeVolume({ error: "x" }, AT), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
});

test("a window GDELT holds nothing for is an answer with no hours, not a malformed one", async () => {
  // What GDELT sent on 2026-10-06 for the last three days, four days after its index stopped.
  const empty = { query_details: { title: "bitcoin", date_resolution: "15m" }, timeline: [] };
  assert.deepEqual(hourlyNarrativeVolume(empty, AT), []);
  assert.deepEqual(hourlyNarrativeVolume({}, AT), [], "its answer for a window before the index begins");
  assert.equal(isEmptyGdeltTimeline(gdelt([["20261001T020000Z", 0.5]])), false);
  assert.equal(isEmptyGdeltTimeline({ timeline: "no" }), false);
  assert.equal(isEmptyGdeltTimeline(null), false);

  const emptyTopics: string[] = [];
  const failures: string[] = [];
  let requests = 0;
  const source = createNarrativeSource({ sleep: async () => {}, onEmptyWindow: (id) => emptyTopics.push(id), onTopicFailure: (id) => failures.push(id),
    fetchImpl: (async () => { requests += 1; return new Response(JSON.stringify(empty), { status: 200 }); }) as typeof fetch });
  assert.deepEqual(await source.collect(AT), []);
  assert.equal(requests, 1, "an empty answer is not asked for again");
  assert.deepEqual(emptyTopics, [narrativeTopicFor(AT).id]);
  assert.deepEqual(failures, []);
});

test("a sweep asks for exactly one topic, and the rotation reaches every topic", async () => {
  const seen = new Set<string>();
  for (let turn = 0; turn < NARRATIVE_TOPICS.length; turn++) {
    seen.add(narrativeTopicFor(new Date(AT.getTime() + turn * NARRATIVE_ROTATION_MS)).id);
  }
  assert.equal(seen.size, NARRATIVE_TOPICS.length, "eight consecutive turns cover all eight topics");
  assert.equal(narrativeTopicFor(AT).id, narrativeTopicFor(new Date(AT.getTime() + 1000)).id, "two replicas in the same turn agree");

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => { urls.push(String(url)); return new Response(JSON.stringify(gdelt([["20261001T020000Z", 0.5]])), { status: 200 }); }) as typeof fetch;
  const observations = await createNarrativeSource({ fetchImpl, sleep: async () => {} }).collect(AT);
  const topic = narrativeTopicFor(AT);
  assert.equal(urls.length, 1, "one request per sweep");
  assert.ok(urls[0]!.includes(new URLSearchParams({ query: topic.query }).toString()) && urls[0]!.includes("timespan=3d"));
  assert.deepEqual(observations.map((o) => o.seriesKey), [`narrative:${topic.id}:news_volume_share`]);
  assert.equal(narrativeSeries().length, NARRATIVE_TOPICS.length);
});

test("a refused topic is asked again after a wait, then reported and left as a gap", async () => {
  const sleeps: number[] = [];
  let request = 0;
  const recovering = createNarrativeSource({ sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: (async () => { request += 1; return request < 3 ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify(gdelt([["20261001T020000Z", 0.5]])), { status: 200 }); }) as typeof fetch });
  assert.equal((await recovering.collect(AT)).length, 1);
  assert.equal(request, 3);
  assert.deepEqual(sleeps, [40_000, 40_000], "the same wait before every further attempt");

  const reported: Array<[string, string, number]> = [];
  let refused = 0;
  const down = createNarrativeSource({ sleep: async () => {}, onTopicFailure: (id, code, attempts) => reported.push([id, code, attempts]),
    fetchImpl: (async () => { refused += 1; return new Response("slow down", { status: 429 }); }) as typeof fetch });
  await assert.rejects(down.collect(AT), (e) => e instanceof SourceError && e.code === "RATE_LIMIT");
  assert.equal(refused, GDELT_MAX_ATTEMPTS, "seven attempts and no more");
  assert.deepEqual(reported, [[narrativeTopicFor(AT).id, "RATE_LIMIT", GDELT_MAX_ATTEMPTS]]);
  assert.ok(GDELT_MAX_ATTEMPTS * GDELT_TIMEOUT_MS + (GDELT_MAX_ATTEMPTS - 1) * GDELT_RETRY_WAIT_MS < NARRATIVE_ROTATION_MS,
    "a turn ends before the next one starts, even if every attempt times out");

  let malformed = 0;
  const broken = createNarrativeSource({ sleep: async () => {},
    fetchImpl: (async () => { malformed += 1; return new Response(JSON.stringify({ timeline: "no" }), { status: 200 }); }) as typeof fetch });
  await assert.rejects(broken.collect(AT), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
  assert.equal(malformed, 1, "a malformed answer is not asked for again");
});

const context = (articles: Array<[string, string]>) => ({ articles: articles.map(([url, seendate]) => ({ url, seendate, sentence: "x" })) });
const H02 = Date.parse("2026-10-01T02:00:00.000Z");
const H03 = Date.parse("2026-10-01T03:00:00.000Z");

test("context mentions are distinct articles seen in the hour", () => {
  assert.equal(contextMentionCount(context([
    ["https://a.test/1", "20261001T020108Z"], ["https://a.test/1", "20261001T021500Z"], ["https://a.test/2", "20261001T025959Z"],
    ["https://a.test/3", "20261001T030000Z"], ["https://a.test/4", "bad"]
  ]), H02, H03), 2, "one article quoted twice is one, and the next hour's article is not this hour's");
  assert.equal(contextMentionCount({}, H02, H03), 0, "an hour with no match is answered without the list");
  const full = context(Array.from({ length: CONTEXT_MAX_RECORDS }, (_, i): [string, string] => [`https://a.test/${i}`, "20261001T020108Z"]));
  assert.equal(contextMentionCount(full, H02, H03), null, "a full page is a count that was cut off");
  assert.throws(() => contextMentionCount({ articles: "no" }, H02, H03), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
  assert.throws(() => contextMentionCount([], H02, H03), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
});

test("a context sweep asks one topic for its last settled hours, one hour at a time", async () => {
  const urls: string[] = [];
  const sleeps: number[] = [];
  const byStart: Record<string, unknown> = {
    "20261001020000": context([["https://a.test/1", "20261001T020108Z"], ["https://a.test/2", "20261001T024500Z"]]),
    "20261001010000": {},
    "20261001000000": context([["https://a.test/3", "20261001T003000Z"]])
  };
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(byStart[new URL(String(url)).searchParams.get("startdatetime")!]), { status: 200 });
  }) as typeof fetch;
  const observations = await createNarrativeContextSource({ fetchImpl, sleep: async (ms) => { sleeps.push(ms); } }).collect(AT);
  const topic = narrativeTopicFor(AT);

  assert.equal(urls.length, CONTEXT_HOURS_PER_SWEEP);
  assert.ok(urls.every((u) => u.includes("/context/context?") && u.includes(new URLSearchParams({ query: topic.query }).toString())), "every request is for the topic whose turn it is");
  assert.deepEqual(urls.map((u) => [new URL(u).searchParams.get("startdatetime"), new URL(u).searchParams.get("enddatetime")]),
    [["20261001020000", "20261001030000"], ["20261001010000", "20261001020000"], ["20261001000000", "20261001010000"]],
    "the hour that ended fifteen minutes ago is not asked for yet");
  assert.deepEqual(sleeps, [CONTEXT_REQUEST_GAP_MS, CONTEXT_REQUEST_GAP_MS]);
  assert.deepEqual(observations, [
    { seriesKey: `narrative:${topic.id}:context_mentions`, eventTime: "2026-10-01T02:00:00.000Z", value: 2, source: NARRATIVE_CONTEXT_SOURCE },
    { seriesKey: `narrative:${topic.id}:context_mentions`, eventTime: "2026-10-01T00:00:00.000Z", value: 1, source: NARRATIVE_CONTEXT_SOURCE }
  ], "an hour with no match is not written");
  assert.equal(narrativeContextSeries().length, NARRATIVE_TOPICS.length);
  assert.ok(narrativeContextSeries().every((s) => !narrativeSeries().some((d) => d.key === s.key)), "the two readings never share a series");
});

test("a context hour that fails is reported and the other hours are kept", async () => {
  const reported: Array<[string, string, string]> = [];
  let request = 0;
  const partial = createNarrativeContextSource({ sleep: async () => {}, onHourFailure: (id, eventTime, code) => reported.push([id, eventTime, code]),
    fetchImpl: (async () => { request += 1; return request === 2 ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify(context([["https://a.test/1", request === 1 ? "20261001T020108Z" : "20261001T000108Z"]])), { status: 200 }); }) as typeof fetch });
  assert.deepEqual((await partial.collect(AT)).map((o) => o.eventTime), ["2026-10-01T02:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  assert.deepEqual(reported, [[narrativeTopicFor(AT).id, "2026-10-01T01:00:00.000Z", "RATE_LIMIT"]]);

  const down = createNarrativeContextSource({ sleep: async () => {}, fetchImpl: (async () => new Response("slow down", { status: 429 })) as typeof fetch });
  await assert.rejects(down.collect(AT), (e) => e instanceof SourceError && e.code === "RATE_LIMIT");
  assert.ok(CONTEXT_HOURS_PER_SWEEP * GDELT_TIMEOUT_MS + (CONTEXT_HOURS_PER_SWEEP - 1) * CONTEXT_REQUEST_GAP_MS < NARRATIVE_ROTATION_MS,
    "a turn ends before the next one starts, even if every request times out");
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
  const full = await createOptionsSource({ underlyings: ["XLU"], fetchImpl: respond(chain) }).collect(SESSION);
  assert.deepEqual(Object.fromEntries(full.map((o) => [o.seriesKey, o.value])), {
    "options:XLU:call_volume": 5, "options:XLU:put_volume": 20, "options:XLU:open_interest": 23, "options:XLU:put_call_volume_ratio": 4 });
  const quiet = { data: { options: [{ option: "XLU261002C00025000", volume: 0, open_interest: 11 }] } };
  const partial = await createOptionsSource({ underlyings: ["XLU"], fetchImpl: respond(quiet) }).collect(SESSION);
  assert.deepEqual(partial.map((o) => o.seriesKey), ["options:XLU:open_interest"]);
  assert.equal(optionsSeries(["XLU"]).length, 2, "raw volume is stored but not scanned");
});

test("the US session is weekdays from the open to an hour after the close, in New York time", () => {
  assert.deepEqual(usEasternClock(new Date("2026-10-01T15:15:00Z")), { date: "2026-10-01", weekday: 4, minutes: 11 * 60 + 15 });
  // Daylight time until 1 November 2026: 09:30 in New York is 13:30 UTC.
  assert.equal(usEquitySessionOpen(new Date("2026-10-01T13:29:00Z")), false);
  assert.equal(usEquitySessionOpen(new Date("2026-10-01T13:30:00Z")), true);
  assert.equal(usEquitySessionOpen(new Date("2026-10-01T20:59:00Z")), true);
  assert.equal(usEquitySessionOpen(new Date("2026-10-01T21:00:00Z")), false);
  // Standard time from 2 November: the same wall-clock hour is 14:30 UTC.
  assert.equal(usEquitySessionOpen(new Date("2026-11-02T13:45:00Z")), false);
  assert.equal(usEquitySessionOpen(new Date("2026-11-02T14:30:00Z")), true);
  assert.equal(usEquitySessionOpen(new Date("2026-10-03T15:15:00Z")), false, "Saturday");
  assert.equal(usEquitySessionOpen(new Date("2026-10-04T15:15:00Z")), false, "Sunday");
});

test("session sources ask nothing while the market is closed", async () => {
  let calls = 0;
  const counting = (async () => { calls += 1; return new Response("{}", { status: 200 }); }) as typeof fetch;
  assert.deepEqual(await createOptionsSource({ fetchImpl: counting }).collect(AT), []);
  assert.deepEqual(await createSectorQuoteSource({ fetchImpl: counting }).collect(new Date("2026-10-03T15:15:00Z")), []);
  assert.equal(calls, 0);
});

const quote = (symbol: string, price: unknown, lastTrade: unknown) => ({ timestamp: "2026-10-01 15:20:00", data: { symbol, current_price: price, last_trade_time: lastTrade }, symbol });

test("a fund's price is taken only from a quote that names it and traded today", () => {
  assert.equal(fundPrice(quote("XLU", 39.83, "2026-10-01T11:14:59"), "XLU", SESSION), 39.83);
  assert.equal(fundPrice(quote("XLU", 39.83, "2026-09-30T15:59:59"), "XLU", SESSION), null, "yesterday's last trade is not today's price");
  for (const bad of [quote("XLE", 39.83, "2026-10-01T11:14:59"), quote("XLU", 0, "2026-10-01T11:14:59"), quote("XLU", "39.83", "2026-10-01T11:14:59"), quote("XLU", 39.83, null), { data: null }]) {
    assert.throws(() => fundPrice(bad, "XLU", SESSION), (e) => e instanceof SourceError && e.code === "MALFORMED_RESPONSE");
  }
});

test("the sector source writes one price per fund and leaves out a fund it could not read", async () => {
  const funds = QUOTED_FUNDS.filter((f) => ["XLU", "CPER", "URA"].includes(f.symbol));
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const symbol = /quotes\/(\w+)\.json$/.exec(String(url))![1]!;
    asked.push(symbol);
    if (symbol === "CPER") return new Response("upstream", { status: 502 });
    return new Response(JSON.stringify(quote(symbol, symbol === "XLU" ? 39.83 : 31.2, symbol === "XLU" ? "2026-10-01T11:14:59" : "2026-09-30T15:59:59")), { status: 200 });
  }) as typeof fetch;
  const rows = await createSectorQuoteSource({ funds, fetchImpl }).collect(SESSION);
  assert.deepEqual(asked, ["XLU", "CPER", "URA"]);
  assert.deepEqual(rows, [{ seriesKey: "fund:XLU:price_usd", eventTime: SESSION.toISOString(), value: 39.83, source: SECTOR_QUOTES_SOURCE }]);

  const failing = (async () => new Response("down", { status: 503 })) as typeof fetch;
  await assert.rejects(createSectorQuoteSource({ funds, fetchImpl: failing }).collect(SESSION), (e) => e instanceof SourceError);

  const series = sectorQuoteSeries();
  assert.equal(series.length, 16);
  assert.equal(new Set(series.map((s) => s.key)).size, 16);
  assert.deepEqual(series.find((s) => s.key === "fund:CPER:price_usd"), { key: "fund:CPER:price_usd", label: "CPER fund price (copper futures)", group: "commodity:copper" });
});
