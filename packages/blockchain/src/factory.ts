import type { AppConfig } from "@aegix/config";
import type { BlockchainProvider } from "./types.js";
import { SolanaRpcProvider } from "./solana/provider.js";
import { ProviderPool, type ProviderPoolOptions } from "./provider-pool.js";

/**
 * Builds a provider pool from configuration, see architecture.md §51.
 * Uses RPC_PRIMARY_URL/RPC_SECONDARY_URL/RPC_TERTIARY_URL when present,
 * falling back to the single RPC_URL.
 */
export function createProviderPoolFromConfig(
  config: AppConfig,
  options: Partial<ProviderPoolOptions> = {}
): ProviderPool {
  const providers: BlockchainProvider[] = [];

  const entries: Array<{ url: string | undefined; name: string | undefined }> = [
    { url: config.RPC_PRIMARY_URL, name: config.RPC_PRIMARY_NAME },
    { url: config.RPC_SECONDARY_URL, name: config.RPC_SECONDARY_NAME },
    { url: config.RPC_TERTIARY_URL, name: config.RPC_TERTIARY_NAME }
  ];

  for (const entry of entries) {
    if (!entry.url) continue;
    providers.push(
      new SolanaRpcProvider(
        { RPC_URL: entry.url, RPC_WEBSOCKET_URL: config.RPC_WEBSOCKET_URL },
        { name: entry.name ?? new URL(entry.url).hostname, timeoutMs: config.ANALYSIS_RPC_TIMEOUT_MS }
      )
    );
  }

  if (providers.length === 0) {
    providers.push(
      new SolanaRpcProvider(
        { RPC_URL: config.RPC_URL, RPC_WEBSOCKET_URL: config.RPC_WEBSOCKET_URL },
        { timeoutMs: config.ANALYSIS_RPC_TIMEOUT_MS }
      )
    );
  }

  return new ProviderPool({
    providers,
    failureThreshold: config.RPC_CIRCUIT_FAILURE_THRESHOLD,
    cooldownMs: config.RPC_CIRCUIT_COOLDOWN_MS,
    ...options
  });
}
