/**
 * Abstraction over a blockchain data source, see architecture.md §39.
 * The intelligence engine must never couple directly to one RPC provider.
 */
export type {
  BlockchainProvider,
  GetSignaturesOptions,
  ProviderHealth,
  ProviderMetrics,
  RawTransaction,
  SignatureInfo,
  TokenAccountInfo
} from "./types.js";
