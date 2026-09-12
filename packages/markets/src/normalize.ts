import type { CanonicalAsset, FreshnessReport, HistoryPoint, QualityReport } from "./types.js";

/**
 * Freshness thresholds.
 *
 * Below FRESH a reading may be shown as current. Between the two it is shown
 * with its age attached. Beyond STALE there is no reading to show: an hours-old
 * price presented as live is worse than no price at all.
 */
export const FRESH_WITHIN_SECONDS = 300;
export const STALE_AFTER_SECONDS = 3600;

/** Judges a reading by the provider's own timestamp, never by arrival time. */
export function assessFreshness(providerTimestamp: string | null, now: Date = new Date()): FreshnessReport {
  const observedAt = now.toISOString();
  if (!providerTimestamp) {
    return { status: "UNAVAILABLE", ageSeconds: null, observedAt, providerTimestamp: null };
  }

  const parsed = Date.parse(providerTimestamp);
  if (Number.isNaN(parsed) || parsed > now.getTime() + 60_000) {
    return { status: "UNAVAILABLE", ageSeconds: null, observedAt, providerTimestamp };
  }

  // Clamped at zero: a provider clock slightly ahead of ours is not negative age.
  const ageSeconds = Math.max(0, Math.round((now.getTime() - parsed) / 1000));
  const status = ageSeconds <= FRESH_WITHIN_SECONDS ? "FRESH" : ageSeconds <= STALE_AFTER_SECONDS ? "STALE" : "UNAVAILABLE";

  return { status, ageSeconds, observedAt, providerTimestamp: new Date(parsed).toISOString() };
}

/** Minimum points before the deviation and volatility measures mean anything. */
export const MIN_HISTORY_POINTS = 7;

/**
 * Grades the dataset behind a snapshot, not the asset.
 *
 * Every downgrade names its reason. A grade with no reasons attached cannot
 * be acted on, and tends to be ignored.
 */
export function assessQuality(input: {
  freshness: FreshnessReport;
  history: HistoryPoint[];
  volume24hUsd: number | null;
  expectedPoints: number;
}): QualityReport {
  const issues: string[] = [];

  if (input.freshness.status === "UNAVAILABLE") issues.push("No usable provider timestamp.");
  else if (input.freshness.status === "STALE") issues.push(`Quote is ${input.freshness.ageSeconds}s old.`);

  if (input.history.length < MIN_HISTORY_POINTS) {
    issues.push(`Only ${input.history.length} history points; ${MIN_HISTORY_POINTS} are needed for distribution measures.`);
  } else if (input.history.length < input.expectedPoints) {
    issues.push(`History has gaps: ${input.history.length} of ${input.expectedPoints} expected points.`);
  }

  if (input.volume24hUsd === null) issues.push("Provider reported no 24h volume.");
  if (input.history.length >= MIN_HISTORY_POINTS) {
    if (input.history.some((p, i) => i > 0 && Date.parse(p.timestamp) - Date.parse(input.history[i - 1]!.timestamp) > 90 * 60_000)) issues.push("Hourly history contains temporal gaps.");
    const latest = Date.parse(input.history.at(-1)!.timestamp);
    if (Date.parse(input.freshness.observedAt) - latest > 2 * 3600_000) issues.push("Latest history observation is more than two hours old.");
  }

  const grade = issues.length === 0 ? "HIGH" : issues.length === 1 ? "MEDIUM" : "LOW";
  return { grade, issues, historyPoints: input.history.length };
}

/** Sorts ascending by timestamp and drops points that cannot be placed in time. */
export function normalizeHistory(points: HistoryPoint[]): HistoryPoint[] {
  const sorted = points
    .filter((p) => !Number.isNaN(Date.parse(p.timestamp)) && Number.isFinite(p.priceUsd) && p.priceUsd > 0)
    .map((p) => ({ ...p, timestamp: new Date(p.timestamp).toISOString(), volumeUsd: p.volumeUsd !== null && Number.isFinite(p.volumeUsd) && p.volumeUsd >= 0 ? p.volumeUsd : null }))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.priceUsd - b.priceUsd || (a.volumeUsd ?? -1) - (b.volumeUsd ?? -1));
  return sorted.filter((p, i) => i === 0 || p.timestamp !== sorted[i - 1]!.timestamp);
}

/** Cache keys carry the provider, so switching providers cannot serve stale values from the old one. */
export function marketCacheKey(provider: string, asset: CanonicalAsset, window: string): string {
  return `markets:${provider}:${asset}:${window}`;
}
