import type { BlockchainProvider, ProviderMetrics } from "./types.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ProviderHealthSnapshot extends ProviderMetrics {
  state: CircuitState;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  failovers: number;
}

/**
 * Per-provider circuit breaker + health tracking, see architecture.md §40, §48.
 * States: CLOSED (healthy) -> OPEN (too many failures, cooldown) -> HALF_OPEN (probe).
 */
export class ProviderCircuit {
  state: CircuitState = "CLOSED";
  consecutiveFailures = 0;
  lastSuccessAt: number | null = null;
  lastFailureAt: number | null = null;
  lastError: string | null = null;
  failovers = 0;
  probeInFlight = false;

  readonly metrics: ProviderMetrics = {
    latencyMs: 0,
    errorRate: 0,
    rateLimited: false,
    requestCount: 0,
    timeoutRate: 0,
    serverErrorRate: 0
  };

  constructor(
    readonly name: string,
    private readonly options: { failureThreshold: number; cooldownMs: number }
  ) {}

  recordSuccess(latencyMs: number): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = Date.now();
    this.lastError = null;
    this.probeInFlight = false;
    this.metrics.latencyMs = this.metrics.latencyMs * 0.9 + latencyMs * 0.1;
    this.metrics.errorRate = Math.max(0, this.metrics.errorRate * 0.9 - 0.05);
    this.metrics.rateLimited = false;
    this.metrics.requestCount += 1;
    if (this.state === "HALF_OPEN") this.state = "CLOSED";
  }

  recordFailure(error: unknown, kind: "rate_limit" | "timeout" | "server_error" | "network"): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = Date.now();
    this.lastError = error instanceof Error ? error.message.slice(0, 200) : String(error);
    this.probeInFlight = false;
    this.metrics.requestCount += 1;
    this.metrics.errorRate = Math.min(1, this.metrics.errorRate * 0.9 + 0.1);
    if (kind === "rate_limit") this.metrics.rateLimited = true;
    if (kind === "timeout") this.metrics.timeoutRate = Math.min(1, this.metrics.timeoutRate * 0.9 + 0.1);
    if (kind === "server_error") this.metrics.serverErrorRate = Math.min(1, this.metrics.serverErrorRate * 0.9 + 0.1);

    if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "OPEN";
    }
  }

  /** Whether a request may be attempted on this provider right now. */
  canAccept(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      const cooldownElapsed = this.lastFailureAt !== null && Date.now() - this.lastFailureAt >= this.options.cooldownMs;
      if (cooldownElapsed) {
        this.state = "HALF_OPEN";
        this.probeInFlight = true;
        return true;
      }
      return false;
    }
    // HALF_OPEN: allow a single probe
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  snapshot(): ProviderHealthSnapshot {
    return {
      ...this.metrics,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      failovers: this.failovers
    };
  }
}

export interface ProviderPoolOptions {
  providers: BlockchainProvider[];
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface ProviderPoolStats {
  circuits: Record<string, ProviderHealthSnapshot>;
  lastProvider: string | null;
}

/**
 * Failover pool with health-based provider selection, see architecture.md §45-§48.
 * Prefers healthy + fast providers, skips OPEN circuits, probes HALF_OPEN ones.
 */
export class ProviderPool implements BlockchainProvider {
  readonly name = "provider-pool";

  private readonly circuits: Map<string, ProviderCircuit>;
  private lastProvider: string | null = null;
  private fallbackIndex = 0;

  constructor(private readonly options: ProviderPoolOptions) {
    this.circuits = new Map(
      options.providers.map((p) => [
        p.name,
        new ProviderCircuit(p.name, {
          failureThreshold: options.failureThreshold ?? 5,
          cooldownMs: options.cooldownMs ?? 30_000
        })
      ])
    );
  }

  get chain() {
    return this.options.providers[0]?.chain ?? "solana";
  }

  validateAddress(address: string): boolean {
    return this.options.providers[0]?.validateAddress(address) ?? false;
  }

  getStats(): ProviderPoolStats {
    return {
      circuits: Object.fromEntries([...this.circuits.entries()].map(([k, c]) => [k, c.snapshot()])),
      lastProvider: this.lastProvider
    };
  }

  /** Ranks providers: healthy preferred, fast preferred, OPEN last (fallback probe). */
  private rankProviders(): BlockchainProvider[] {
    const now = Date.now();
    return [...this.options.providers].sort((a, b) => {
      const ca = this.circuits.get(a.name)!;
      const cb = this.circuits.get(b.name)!;
      const score = (c: ProviderCircuit) => {
        if (c.state === "OPEN") return 1_000_000;
        let s = c.metrics.errorRate * 10_000 + c.metrics.latencyMs;
        if (c.metrics.rateLimited) s += 500;
        if (c.metrics.timeoutRate > 0.3) s += 20_000;
        if (c.metrics.serverErrorRate > 0.3) s += 10_000;
        // recency bonus: prefer providers with recent successes
        if (c.lastSuccessAt !== null && now - c.lastSuccessAt < 60_000) s -= 500;
        // measured providers are preferred over unmeasured ones (avoids blind rotation)
        if (c.metrics.requestCount === 0) s += 250;
        return s;
      };
      return score(ca) - score(cb);
    });
  }

  private classifyError(err: unknown): "rate_limit" | "timeout" | "server_error" | "network" {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("429") || message.includes("rate limit")) return "rate_limit";
    if (message.includes("timeout") || message.includes("ETIMEDOUT")) return "timeout";
    if (message.includes("502") || message.includes("503") || message.includes("500")) return "server_error";
    return "network";
  }

  private async withFailover<T>(fn: (p: BlockchainProvider) => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    const ranked = this.rankProviders();
    const tried = new Set<string>();

    for (const provider of ranked) {
      const circuit = this.circuits.get(provider.name)!;
      if (!circuit.canAccept()) continue;
      tried.add(provider.name);
      const started = Date.now();
      try {
        const result = await fn(provider);
        circuit.recordSuccess(Date.now() - started);
        if (this.lastProvider && this.lastProvider !== provider.name) {
          // a failover happened
          circuit.failovers += 1;
        }
        this.lastProvider = provider.name;
        return result;
      } catch (err) {
        lastError = err;
        circuit.recordFailure(err, this.classifyError(err));
      }
    }

    // Fallback: force-probe the best-ranked OPEN provider once (degraded mode)
    for (const provider of this.options.providers) {
      if (tried.has(provider.name)) continue;
      const circuit = this.circuits.get(provider.name)!;
      if (circuit.state !== "OPEN") continue;
      try {
        const result = await fn(provider);
        circuit.recordSuccess(0);
        circuit.failovers += 1;
        this.lastProvider = provider.name;
        return result;
      } catch (err) {
        lastError = err;
        circuit.recordFailure(err, this.classifyError(err));
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
