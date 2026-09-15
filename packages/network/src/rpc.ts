import { CHAINS, parseChain, type NetworkChain } from "./chains.js";
import { height, type BlockSource, type IndexedBlock } from "./indexer.js";
import { setTimeout as sleep } from "node:timers/promises";

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;
const RAW_RPC = Symbol("aegix.rawRpc");
export function createRpc(url: string, minimumIntervalMs = 200): RpcCall {
  const endpoint = new URL(url);
  if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("Invalid RPC protocol");
  let nextRequest = 0;
  return async (method, params) => {
    const wait = Math.max(0, nextRequest - Date.now());
    nextRequest = Date.now() + wait + minimumIntervalMs;
    if (wait) await sleep(wait);
    // No URLs/provider errors in logs: endpoints can contain API credentials.
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000)
      });
    } catch { throw new Error(`RPC ${method} transport failure`); }
    if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
    let body: Record<string, unknown>;
    let rawRpc: string;
    try { rawRpc = await response.text(); body = object(JSON.parse(rawRpc)); } catch { throw new Error("Invalid RPC JSON"); }
    if (body.jsonrpc !== "2.0" || body.id !== 1 || body.error || !Object.hasOwn(body, "result")) {
      const code = body.error && typeof body.error === "object" ? (body.error as { code?: unknown }).code : undefined;
      throw new Error(`RPC ${method} rejected${typeof code === "number" && Number.isSafeInteger(code) ? ` (code ${code})` : ""}`);
    }
    if (body.result && typeof body.result === "object") Object.defineProperty(body.result, RAW_RPC, { value: rawRpc });
    return body.result;
  };
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
