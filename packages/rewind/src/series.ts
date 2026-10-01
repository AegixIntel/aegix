/**
 * Series identities written to the observation ledger.
 *
 * A key names what was measured, never who supplied it: the provider is the
 * `source` column on the ledger row, so replacing one does not fork a series.
 */

export type MarketMetric = "price_usd" | "volume_24h_usd";

export const MARKET_METRICS: readonly MarketMetric[] = ["price_usd", "volume_24h_usd"];

export interface SeriesDescriptor {
  key: string;
  label: string;
  /** What the series belongs to; relationships are drawn between groups. */
  group: string;
}

export function marketSeriesKey(asset: string, metric: MarketMetric): string {
  return `market:${asset}:${metric}`;
}

export function marketSeries(assets: readonly string[]): SeriesDescriptor[] {
  return assets.flatMap((asset) => [
    { key: marketSeriesKey(asset, "price_usd"), label: `${asset} price (USD)`, group: asset },
    { key: marketSeriesKey(asset, "volume_24h_usd"), label: `${asset} rolling 24h volume (USD)`, group: asset }
  ]);
}
