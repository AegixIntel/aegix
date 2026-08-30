import { Connection, PublicKey } from "@solana/web3.js";
import type { AppConfig } from "@aegix/config";
import type {
  AccountInfo,
  BlockchainProvider,
  GetSignaturesOptions,
  RawTransaction,
  SignatureInfo,
  TokenAccountInfo
} from "../types.js";
import { formatSignatureInfo, formatTokenAccount, isValidSolanaAddress } from "./address.js";

const DEFAULT_COMMITMENT = "confirmed";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAX_RETRIES = 2;

export interface SolanaRpcOptions {
  name?: string;
  timeoutMs?: number;
}

/**
 * Solana RPC provider implementing BlockchainProvider, see architecture.md §39-§41.
 * Applies bounded retries with exponential backoff on transient failures
 * (HTTP 429, timeouts, connection errors) and a per-request timeout.
 */
export class SolanaRpcProvider implements BlockchainProvider {
  readonly chain = "solana" as const;
  readonly name: string;

  private readonly connection: Connection;
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private rpcId = 0;

  constructor(
    config: Pick<AppConfig, "RPC_URL" | "RPC_WEBSOCKET_URL">,
    options: SolanaRpcOptions = {}
  ) {
    this.name = options.name ?? new URL(config.RPC_URL).hostname;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.rpcUrl = config.RPC_URL;
    this.connection = new Connection(config.RPC_URL, {
      commitment: DEFAULT_COMMITMENT,
      wsEndpoint: config.RPC_WEBSOCKET_URL,
      confirmTransactionInitialTimeout: this.timeoutMs
    });
  }

  validateAddress(address: string): boolean {
    return isValidSolanaAddress(address);
  }

  async getSignatures(address: string, options: GetSignaturesOptions = {}): Promise<SignatureInfo[]> {
    return this.withRetry(async () => {
      const result = await this.connection.getSignaturesForAddress(
        this.pubkey(address),
        {
          limit: options.limit ?? 100,
          before: options.before,
          until: options.until
        },
        DEFAULT_COMMITMENT
      );
      return result.map((sig) =>
        formatSignatureInfo({ signature: sig.signature, slot: sig.slot, blockTime: sig.blockTime })
      );
    });
  }

  async getTransaction(signature: string): Promise<RawTransaction | null> {
    return this.withRetry(async () => {
      // Some RPC gateways do not expose the getParsedTransaction method but
      // honor the jsonParsed encoding on getTransaction. Use a direct JSON-RPC
      // call to stay compatible with both.
      const response = await this.rpcCall<{
        slot: number;
        blockTime: number | null;
        meta?: unknown;
        transaction?: unknown;
      } | null>("getTransaction", [
        signature,
        { commitment: DEFAULT_COMMITMENT, maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }
      ]);
      if (!response) return null;
      return {
        signature,
        slot: response.slot,
        blockTime: response.blockTime ?? null,
        json: response
      };
    });
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.rpcId;
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });
    if (!res.ok) {
      throw new Error(`RPC HTTP ${res.status} for ${method}`);
    }
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) {
      throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
    }
    return body.result as T;
  }

  async getTokenAccounts(address: string): Promise<TokenAccountInfo[]> {
    return this.withRetry(async () => {
      const result = await this.connection.getParsedTokenAccountsByOwner(
        this.pubkey(address),
        { programId: TOKEN_PROGRAM_ID },
        DEFAULT_COMMITMENT
      );
      return result.value
        .map((v) => formatTokenAccount({ account: v.account }))
        .filter((v): v is TokenAccountInfo => v !== null);
    });
  }

  async getAccountInfo(address: string): Promise<AccountInfo | null> {
    return this.withRetry(async () => {
      const account = await this.connection.getAccountInfo(this.pubkey(address), DEFAULT_COMMITMENT);
      if (!account) return null;
      return {
        owner: account.owner.toBase58(),
        executable: account.executable,
        lamports: account.lamports,
        dataLength: account.data.length,
        data: ""
      };
    });
  }

  async getBalance(address: string): Promise<number> {
    return this.withRetry(() => this.connection.getBalance(this.pubkey(address), DEFAULT_COMMITMENT));
  }

  async getLatestBlockHeight(): Promise<number> {
    return this.withRetry(() => this.connection.getBlockHeight(DEFAULT_COMMITMENT));
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await withTimeout(fn(), this.timeoutMs);
      } catch (err) {
        lastError = err;
        const retryable = isRetryable(err);
        if (!retryable || attempt === MAX_RETRIES) break;
        const delay = 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private pubkey(address: string): PublicKey {
    return new PublicKey(address);
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  return (
    message.includes("429") ||
    message.includes("fetch failed") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("timeout") ||
    message.includes("503") ||
    message.includes("502")
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RPC_TIMEOUT")), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
