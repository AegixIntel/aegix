import type { Chain } from "@aegix/types";

export interface GetSignaturesOptions {
  limit?: number;
  before?: string;
  until?: string;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
}

export interface TokenAccountInfo {
  mint: string;
  amount: string;
  decimals: number;
  owner: string;
}

export interface RawTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  json: unknown;
}

export interface BlockchainProvider {
  readonly chain: Chain;
  readonly name: string;

  validateAddress(address: string): boolean;

  getSignatures(address: string, options?: GetSignaturesOptions): Promise<SignatureInfo[]>;

  getTransaction(signature: string): Promise<RawTransaction | null>;

  getTokenAccounts(address: string): Promise<TokenAccountInfo[]>;

  getBalance(address: string): Promise<number>;

  getLatestBlockHeight(): Promise<number>;
}

export interface ProviderMetrics {
  latencyMs: number;
  errorRate: number;
  rateLimited: boolean;
  requestCount: number;
  timeoutRate: number;
  serverErrorRate: number;
}

export interface ProviderHealth {
  healthy: boolean;
  metrics: ProviderMetrics;
}
