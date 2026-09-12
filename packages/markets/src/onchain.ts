import type { MarketSnapshot } from "./types.js";

/** Relates observed timestamps only, without attributing a wallet's activity to markets. */
export function marketTemporalContext(snapshot: MarketSnapshot, events: Array<{ evidenceId: string; timestamp: string }>, windowMinutes = 60) {
  const boundedWindow = Math.max(1, Math.min(1440, Number.isFinite(windowMinutes) ? windowMinutes : 60));
  const history = snapshot.history;
  return events.slice(0, 100).flatMap((event) => {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp) || !/^(sig|ind|cov):[A-Za-z0-9_:.\-]+$/.test(event.evidenceId)) return [];
    const nearest = [...history].sort((a, b) => Math.abs(Date.parse(a.timestamp) - timestamp) - Math.abs(Date.parse(b.timestamp) - timestamp) || a.timestamp.localeCompare(b.timestamp))[0];
    if (!nearest || Math.abs(Date.parse(nearest.timestamp) - timestamp) > boundedWindow * 60_000) return [];
    return [{ id: `cov:market:${snapshot.quote.asset}:${event.evidenceId}`, asset: snapshot.quote.asset,
      evidenceRefs: [event.evidenceId, `cov:market:${snapshot.quote.asset}:history`], onChainTimestamp: new Date(timestamp).toISOString(),
      marketTimestamp: nearest.timestamp, priceUsd: nearest.priceUsd,
      offsetSeconds: Math.round((Date.parse(nearest.timestamp) - timestamp) / 1000),
      note: "Temporal proximity only. This does not establish causation, ownership, or trading intent." }];
  });
}
