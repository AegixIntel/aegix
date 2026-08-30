import type { BlockchainProvider, ProviderMetrics } from "./types.js";

/** Tracks per-provider health to support failover, see architecture.md §40. */
export class ProviderHealthTracker {
  private readonly metrics = new Map<string, ProviderMetrics>();
  private readonly failureCounts = new Map<string, number>();

  constructor(
    private readonly options: {
      failureThreshold: number;
      resetAfterMs: number;
    }
  ) {}

  recordSuccess(name: string, latencyMs: number): void {
    const m = this.metrics.get(name) ?? { latencyMs: 0, errorRate: 0, rateLimited: false, requestCount: 0 };
    m.latencyMs = m.latencyMs * 0.9 + latencyMs * 0.1;
    m.errorRate = m.errorRate * 0.9;
    m.rateLimited = false;
    m.requestCount += 1;
    this.metrics.set(name, m);
    this.failureCounts.set(name, 0);
  }

  recordFailure(name: string, rateLimited: boolean): void {
    const m = this.metrics.get(name) ?? { latencyMs: 0, errorRate: 0, rateLimited: false, requestCount: 0 };
    m.errorRate = Math.min(1, m.errorRate * 0.9 + 0.1);
    m.rateLimited = rateLimited;
    m.requestCount += 1;
    this.metrics.set(name, m);
    this.failureCounts.set(name, (this.failureCounts.get(name) ?? 0) + 1);
  }

  isOpen(name: string): boolean {
    const failures = this.failureCounts.get(name) ?? 0;
    return failures >= this.options.failureThreshold;
  }

  getMetrics(name: string): ProviderMetrics {
    return this.metrics.get(name) ?? { latencyMs: 0, errorRate: 0, rateLimited: false, requestCount: 0 };
  }
}

export interface ProviderPoolOptions {
  providers: BlockchainProvider[];
  health: ProviderHealthTracker;
}

/**
 * Failover pool over multiple providers, see architecture.md §40.
 * Routes around unhealthy providers without flooding them.
 */
export class ProviderPool implements BlockchainProvider {
  readonly name = "provider-pool";

  private readonly providers: BlockchainProvider[];
  private readonly health: ProviderHealthTracker;

  constructor(private readonly options: ProviderPoolOptions) {
    this.providers = options.providers;
    this.health = options.health;
  }

  get chain() {
    return this.providers[0]?.chain ?? "solana";
  }

  validateAddress(address: string): boolean {
    return this.providers[0]?.validateAddress(address) ?? false;
  }

  private async withFailover<T>(fn: (p: BlockchainProvider) => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      if (this.health.isOpen(provider.name)) continue;
      try {
        const result = await fn(provider);
        this.health.recordSuccess(provider.name, 0);
        return result;
      } catch (err) {
        lastError = err;
        const rateLimited = err instanceof Error && err.message.includes("429");
        this.health.recordFailure(provider.name, rateLimited);
      }
    }
    throw lastError ?? new Error("all providers failed");
  }

  getSignatures(address: string, options?: { limit?: number; before?: string; until?: string }) {
    return this.withFailover((p) => p.getSignatures(address, options));
  }

  getTransaction(signature: string) {
    return this.withFailover((p) => p.getTransaction(signature));
  }

  getTokenAccounts(address: string) {
    return this.withFailover((p) => p.getTokenAccounts(address));
  }

  getBalance(address: string) {
    return this.withFailover((p) => p.getBalance(address));
  }

  getLatestBlockHeight() {
    return this.withFailover((p) => p.getLatestBlockHeight());
  }
}
