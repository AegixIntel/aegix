/**
 * Statistics for the Discovery Engine.
 *
 * Everything here is deterministic: no random surrogates, so a run can be
 * reproduced from the ledger and the engine version alone.
 */

export function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Pearson correlation, or null when either side has no variance. */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  if (saa <= 0 || sbb <= 0) return null;
  return Math.max(-1, Math.min(1, sab / Math.sqrt(saa * sbb)));
}

/** Sample autocorrelation at one lag. */
export function autocorrelation(values: number[], lag: number): number {
  const n = values.length;
  if (lag <= 0 || lag >= n) return 0;
  const m = mean(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (values[i]! - m) ** 2;
  if (den <= 0) return 0;
  for (let i = 0; i < n - lag; i++) num += (values[i]! - m) * (values[i + lag]! - m);
  return num / den;
}

/**
 * Effective sample size for a correlation between two autocorrelated series
 * (Bartlett's formula, as applied by Pyper & Peterman 1998):
 *
 *   n_eff = n / (1 + 2 · Σ_k ρ_a(k) · ρ_b(k))
 *
 * Two smooth series correlate by accident far more often than two noisy
 * ones; testing them as if every point were independent is the usual source
 * of spurious relationships. n_eff is never allowed above n.
 */
export function effectiveSampleSize(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const maxLag = Math.min(24, Math.floor(n / 4));
  let sum = 0;
  for (let k = 1; k <= maxLag; k++) sum += autocorrelation(a, k) * autocorrelation(b, k);
  const denominator = 1 + 2 * sum;
  if (denominator <= 1) return n;
  return Math.max(4, n / denominator);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Two-sided p-value for H0: ρ = 0, by the Fisher z-transform at n_eff. */
export function correlationPValue(r: number, nEffective: number): number {
  if (nEffective <= 3) return 1;
  const bounded = Math.max(-0.999999, Math.min(0.999999, r));
  const z = Math.atanh(bounded) * Math.sqrt(nEffective - 3);
  return Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
}

/**
 * Benjamini–Yekutieli adjusted p-values (q-values).
 *
 * BY rather than Benjamini–Hochberg because the hypotheses share series and
 * so are dependent in ways BH does not cover. The cost is the harmonic
 * factor c(m) = Σ 1/i, which makes it stricter.
 */
export function benjaminiYekutieli(pValues: number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  let c = 0;
  for (let i = 1; i <= m; i++) c += 1 / i;
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const q = new Array<number>(m).fill(1);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, index } = order[rank - 1]!;
    running = Math.min(running, (p * m * c) / rank);
    q[index] = Math.min(1, running);
  }
  return q;
}
