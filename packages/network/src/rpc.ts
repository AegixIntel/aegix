import { CHAINS, parseChain, type NetworkChain } from "./chains.js";
import { height, type BlockSource, type IndexedBlock } from "./indexer.js";
import { setTimeout as sleep } from "node:timers/promises";

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;
const RAW_RPC = Symbol("aegix.rawRpc");

/** A valid JSON-RPC error response: the endpoint answered, so it is not unhealthy. */
export class RpcRequestError extends Error {
  constructor(method: string, code: unknown) {
    super(`RPC ${method} rejected${typeof code === "number" && Number.isSafeInteger(code) ? ` (code ${code})` : ""}`);
    this.name = "RpcRequestError";
  }
}

export interface RpcPoolOptions {
  /** Minimum spacing between requests to the same endpoint. */
  minimumIntervalMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts across endpoints before giving up. */
  maxAttempts?: number;
  /** How long an endpoint that failed at the transport level is skipped. */
  cooldownMs?: number;
}
export interface RpcPoolStats {
  calls: number;
  attempts: number;
  endpointFailures: number;
  /** Keyed by configured position; endpoints can carry credentials, so never by URL. */
  endpoints: Array<{ index: number; calls: number; failures: number; cooling: boolean }>;
}
export interface RpcPool {
  call: RpcCall;
  endpointCount: number;
  stats(): RpcPoolStats;
}

function endpointOf(url: string): URL {
  const endpoint = new URL(url);
  if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("Invalid RPC protocol");
  return endpoint;
}

/**
 * Rotates across independent RPC endpoints so one provider outage does not stop
 * ingestion. Spacing is enforced per endpoint, and provider URLs never appear in
 * errors or statistics because they routinely carry an API key.
 */
export function createRpcPool(urls: readonly string[], options: RpcPoolOptions = {}): RpcPool {
  if (!urls.length) throw new Error("At least one RPC endpoint is required");
  const minimumIntervalMs = options.minimumIntervalMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? Math.max(1, urls.length);
  const cooldownMs = options.cooldownMs ?? 30_000;
  for (const [name, value] of [["minimumIntervalMs", minimumIntervalMs], ["timeoutMs", timeoutMs],
    ["maxAttempts", maxAttempts], ["cooldownMs", cooldownMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  }
  if (maxAttempts < 1) throw new Error("Invalid maxAttempts");

  const targets = urls.map(url => ({ endpoint: endpointOf(url), calls: 0, failures: 0, nextRequestAt: 0, cooldownUntil: 0 }));
  let calls = 0;
  let attempts = 0;
  let endpointFailures = 0;

  function select(now: number) {
    let best: (typeof targets)[number] | undefined;
    for (const target of targets) {
      if (target.cooldownUntil > now) continue;
      if (!best || target.nextRequestAt < best.nextRequestAt) best = target;
    }
    // Every endpoint is cooling: wait for the one that recovers first.
    if (!best) best = targets.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b));
    return best;
  }

  const call: RpcCall = async (method, params) => {
    calls += 1;
    let lastFailure = new Error(`RPC ${method} unavailable`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      attempts += 1;
      const target = select(Date.now());
      const wait = Math.max(0, target.nextRequestAt - Date.now(), target.cooldownUntil - Date.now());
      target.nextRequestAt = Date.now() + wait + minimumIntervalMs;
      if (wait) await sleep(wait);
      target.calls += 1;

      const penalize = (error: Error) => {
        lastFailure = error;
        target.failures += 1;
        endpointFailures += 1;
        target.cooldownUntil = Date.now() + cooldownMs;
      };

      let response: Response | undefined;
      try {
        response = await fetch(target.endpoint, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch { response = undefined; }
      if (!response) { penalize(new Error(`RPC ${method} transport failure`)); continue; }
      // A provider answering 429 is throttling, not serving a usable result.
      if (!response.ok) { penalize(new Error(`RPC ${method} HTTP ${response.status}`)); continue; }

      let body: Record<string, unknown>;
      let rawRpc: string;
      try {
        rawRpc = await response.text();
        const parsed: unknown = JSON.parse(rawRpc);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch { penalize(new Error("Invalid RPC JSON")); continue; }

      // A well-formed rejection is the endpoint doing its job: do not rotate away
      // from it, and do not hide the reason behind a generic failure.
      if (body.jsonrpc !== "2.0" || body.id !== 1 || body.error || !Object.hasOwn(body, "result")) {
        const code = body.error && typeof body.error === "object" ? (body.error as { code?: unknown }).code : undefined;
        throw new RpcRequestError(method, code);
      }
      if (body.result && typeof body.result === "object") Object.defineProperty(body.result, RAW_RPC, { value: rawRpc });
      return body.result;
    }
    throw lastFailure;
  };

  return {
    call, endpointCount: targets.length,
    stats: () => ({ calls, attempts, endpointFailures,
      endpoints: targets.map((target, index) => ({ index, calls: target.calls, failures: target.failures,
        cooling: target.cooldownUntil > Date.now() })) })
  };
}

/** Single-endpoint call without rotation, kept for callers that hold one URL. */
export function createRpc(url: string, minimumIntervalMs = 200): RpcCall {
  return createRpcPool([url], { minimumIntervalMs, maxAttempts: 1 }).call;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid RPC object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid RPC string");
  return value;
}
function quantity(value: unknown): number {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error("Invalid RPC quantity");
  return height(Number(BigInt(value)));
}

export function createBlockSource(chain: NetworkChain, rpc: RpcCall): BlockSource {
  const spec = CHAINS[parseChain(chain)];
  const solana = spec.family === "solana";
  return {
    chain,
    async verifyNetwork() {
      const actual = await rpc(solana ? "getGenesisHash" : "eth_chainId", []);
      if (actual !== spec.networkId) throw new Error("RPC network does not match configured chain");
    },
    async finalizedHeight() {
      return solana ? height(await rpc("getSlot", [{ commitment: "finalized" }]))
        : quantity(object(await rpc("eth_getBlockByNumber", ["finalized", false])).number);
    },
    async firstAvailableHeight() {
      return solana ? height(await rpc("getFirstAvailableBlock", [])) : 0;
    },
    async heights(from, to) {
      if (solana) {
        const slots = await rpc("getBlocks", [from, to, { commitment: "finalized" }]);
        if (!Array.isArray(slots)) throw new Error("Invalid Solana block list");
        return slots.map(height);
      }
      return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    },
    async block(requested): Promise<IndexedBlock> {
      const raw = await rpc(solana ? "getBlock" : "eth_getBlockByNumber", solana
        ? [requested, { commitment: "finalized", encoding: "jsonParsed", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1 }]
        : [`0x${requested.toString(16)}`, true]);
      const block = object(raw); // Null is unavailable, never silently skipped.
      if (!Array.isArray(block.transactions)) throw new Error("Missing block transactions");
      if (!solana && quantity(block.number) !== requested) throw new Error("Wrong EVM block returned");
      return {
        chain, height: requested,
        hash: string(solana ? block.blockhash : block.hash),
        parentHeight: solana ? height(block.parentSlot) : Math.max(0, requested - 1),
        parentHash: string(solana ? block.previousBlockhash : block.parentHash), raw,
        rawRpc: (block as Record<symbol, string | undefined>)[RAW_RPC]
      };
    }
  };
}
