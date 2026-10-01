import { MARKETS_ENGINE_VERSION, type HistoryPoint, type MarketSignal } from "./types.js";
import { MIN_HISTORY_POINTS, normalizeHistory } from "./normalize.js";

/**
 * Deterministic market signals.
 *
 * Every one is a measurement with a stated threshold. None is a prediction,
 * none is advice, and none infers intent: an anomaly is an observation that a
 * value sits far from its recent distribution, which is all it is. Whether
 * that reflects manipulation, a listing, a liquidation or ordinary news is
 * not observable from price and volume, so it is not claimed.
 */

const PRICE_DEVIATION_SIGMA = 2;
const VOLUME_SPIKE_RATIO = 2.5;
const VOLATILITY_EXPANSION_RATIO = 1.8;
const MOMENTUM_PERCENT = 10;
const ANOMALY_SIGMA = 3;

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1));
}

/** Day-over-day returns, used for both volatility measures. */
function returns(points: HistoryPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.priceUsd;
    const curr = points[i]!.priceUsd;
    if (prev > 0) out.push((curr - prev) / prev);
  }
  return out;
}

function signal(
  type: MarketSignal["type"],
  asset: string,
  severity: number,
  confidence: number,
  title: string,
  summary: string,
  evidence: MarketSignal["evidence"]
): MarketSignal {
  return {
    id: `sig:market:${asset}:${type}`,
    type,
    asset,
    severity: Math.max(0, Math.min(100, Math.round(severity))),
    confidence: Math.max(0, Math.min(1, confidence)),
    title,
    summary,
    evidence,
    engineVersion: MARKETS_ENGINE_VERSION
  };
}

export interface SignalInput {
  asset: string;
  currentPrice: number;
  currentVolume: number | null;
  history: HistoryPoint[];
}

/**
 * Computes every signal the data supports.
 *
 * Below the minimum sample nothing is emitted. A deviation measured against
 * three points describes the three points, not the market.
 */
export function computeMarketSignals(input: SignalInput): MarketSignal[] {
  const { asset, currentPrice, currentVolume } = input;
  const history = normalizeHistory(input.history).slice(-288);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return [];
  if (history.length < MIN_HISTORY_POINTS) return [];

  const prices = history.map((p) => p.priceUsd);
  const avgPrice = mean(prices);
  const sd = stdDev(prices, avgPrice);
  const signals: MarketSignal[] = [];

  if (sd > 0) {
    const deviation = Math.abs(currentPrice - avgPrice) / sd;
    if (deviation >= PRICE_DEVIATION_SIGMA) {
      signals.push(
        signal(
          "PRICE_DEVIATION",
          asset,
          Math.min(100, deviation * 25),
          0.7,
          "Price is far from its recent average",
          `The current price sits ${deviation.toFixed(1)} standard deviations from the ${history.length}-point mean. This describes distance from a recent distribution, not a forecast.`,
          [
            { key: "deviationSigma", value: Number(deviation.toFixed(2)), label: "Standard deviations" },
            { key: "meanPrice", value: Number(avgPrice.toFixed(2)), label: "Mean price (USD)" },
            { key: "points", value: history.length, label: "History points" }
          ]
        )
      );
    }

    if (deviation >= ANOMALY_SIGMA) {
      signals.push(
        signal(
          "ANOMALY",
          asset,
          Math.min(100, deviation * 28),
          0.6,
          "Reading is an outlier against recent history",
          `The current price is ${deviation.toFixed(1)} standard deviations from the recent mean, beyond the ${ANOMALY_SIGMA}σ threshold. This is a statistical outlier, not evidence of manipulation or any cause.`,
          [
            { key: "deviationSigma", value: Number(deviation.toFixed(2)), label: "Standard deviations" },
            { key: "threshold", value: ANOMALY_SIGMA, label: "Outlier threshold" }
          ]
        )
      );
    }
  }

  const volumes = history.map((p) => p.volumeUsd).filter((v): v is number => typeof v === "number" && v > 0);
  if (currentVolume !== null && volumes.length >= MIN_HISTORY_POINTS - 1) {
    const avgVolume = mean(volumes);
    const ratio = avgVolume > 0 ? currentVolume / avgVolume : 0;
    if (ratio >= VOLUME_SPIKE_RATIO) {
      signals.push(
        signal(
          "VOLUME_SPIKE",
          asset,
          Math.min(100, ratio * 20),
          0.75,
          "24h volume is elevated against its recent average",
          `Volume is ${ratio.toFixed(1)}× the ${volumes.length}-point average. Elevated volume is an observation about trading activity, not about any participant.`,
          [
            { key: "volumeRatio", value: Number(ratio.toFixed(2)), label: "Times average" },
            { key: "averageVolume", value: Number(avgVolume.toFixed(0)), label: "Average volume (USD)" }
          ]
        )
      );
    }
  }

  const rets = returns(history);
  if (rets.length >= MIN_HISTORY_POINTS - 1) {
    const half = Math.floor(rets.length / 2);
    const older = rets.slice(0, half);
    const recent = rets.slice(half);
    const olderVol = stdDev(older, mean(older));
    const recentVol = stdDev(recent, mean(recent));
    const ratio = olderVol > 0 ? recentVol / olderVol : 0;

    if (ratio >= VOLATILITY_EXPANSION_RATIO) {
      signals.push(
        signal(
          "VOLATILITY_EXPANSION",
          asset,
          Math.min(100, ratio * 30),
          0.65,
          "Recent volatility exceeds the earlier window",
          `Volatility over the recent half of the window is ${ratio.toFixed(1)}× the earlier half. Expansion describes dispersion of returns, not direction.`,
          [
            { key: "volatilityRatio", value: Number(ratio.toFixed(2)), label: "Times earlier volatility" },
            { key: "windowPoints", value: rets.length, label: "Return observations" }
          ]
        )
      );
    }
  }

  const first = history[0]!.priceUsd;
  if (first > 0) {
    const changePercent = ((currentPrice - first) / first) * 100;
    if (Math.abs(changePercent) >= MOMENTUM_PERCENT) {
      signals.push(
        signal(
          "MOMENTUM",
          asset,
          Math.min(100, Math.abs(changePercent) * 2),
          0.7,
          "Sustained directional move across the window",
          `The price moved ${changePercent >= 0 ? "up" : "down"} ${Math.abs(changePercent).toFixed(1)}% across the analysed window. This is a description of what happened, and carries no expectation about what happens next.`,
          [
            { key: "changePercent", value: Number(changePercent.toFixed(2)), label: "Change across window (%)" },
            { key: "windowPoints", value: history.length, label: "History points" }
          ]
        )
      );
    }
  }

  return signals.sort((a, b) => b.severity - a.severity || a.type.localeCompare(b.type));
}
