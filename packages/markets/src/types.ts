export const MARKETS_ENGINE_VERSION = "markets-v1.0.0";

/**
 * Canonical asset identity.
 *
 * Product code names assets this way and never by a provider's identifier.
 * A provider is a source of values, not the definition of what an asset is —
 * without this split, replacing one would mean rewriting every caller.
 */
export type CanonicalAsset = "BTC" | "ETH" | "SOL";

export const CANONICAL_ASSETS: readonly CanonicalAsset[] = ["BTC", "ETH", "SOL"];

export function isCanonicalAsset(value: string): value is CanonicalAsset {
  return (CANONICAL_ASSETS as readonly string[]).includes(value);
}

/**
 * How current a reading is.
 *
 * FRESH and STALE are both usable; the difference is whether the caller may
 * present it without qualification. UNAVAILABLE means there is no reading,
 * which is not the same as a reading of zero.
 */
export type Freshness = "FRESH" | "STALE" | "UNAVAILABLE";

export interface FreshnessReport {
  status: Freshness;
  /** Age of the provider's own timestamp, not of our request. */
  ageSeconds: number | null;
  observedAt: string;
  providerTimestamp: string | null;
}

export type QualityGrade = "HIGH" | "MEDIUM" | "LOW";

export interface QualityReport {
  grade: QualityGrade;
  /** Named reasons, so a LOW grade can be acted on rather than guessed at. */
  issues: string[];
  historyPoints: number;
}

export interface NormalizedQuote {
  asset: CanonicalAsset;
  priceUsd: number;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  percentChange24h: number | null;
  provider: string;
  freshness: FreshnessReport;
}

export interface HistoryPoint {
  timestamp: string;
  priceUsd: number;
  volumeUsd: number | null;
}

export type MarketSignalType =
  | "PRICE_DEVIATION"
  | "VOLUME_SPIKE"
  | "VOLATILITY_EXPANSION"
  | "MOMENTUM"
  | "ANOMALY";

export interface MarketSignal {
  id: string;
  type: MarketSignalType;
  /** A canonical asset, or another priced subject such as a tokenized stock symbol. */
  asset: string;
  severity: number;
  confidence: number;
  title: string;
  /** Neutral description of what was measured. Never a recommendation. */
  summary: string;
  evidence: Array<{ key: string; value: string | number; label: string }>;
  engineVersion: string;
}

export interface MarketSnapshot {
  quote: NormalizedQuote;
  history: HistoryPoint[];
  quality: QualityReport;
  signals: MarketSignal[];
  engineVersion: string;
  providerStatus: "OK" | "DEGRADED";
  limitations: string[];
}

export type MarketErrorCode = "PROVIDER_ERROR" | "RATE_LIMIT" | "TIMEOUT" | "MALFORMED_RESPONSE" | "UNKNOWN_ASSET";

export class MarketError extends Error {
  readonly code: MarketErrorCode;
  constructor(code: MarketErrorCode, message: string) {
    super(message);
    this.name = "MarketError";
    this.code = code;
  }
}

export interface MarketDataProvider {
  readonly name: string;
  getQuote(asset: CanonicalAsset): Promise<NormalizedQuote>;
  getHistory(asset: CanonicalAsset, days: number): Promise<HistoryPoint[]>;
}
