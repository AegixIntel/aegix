"use client";

import { useEffect, useState } from "react";
import { getPublicStats, type PublicStats } from "@/lib/api";

function fmt(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const STATS: Array<{ key: keyof PublicStats; label: string }> = [
  { key: "analyses", label: "Analyses" },
  { key: "walletsAnalyzed", label: "Wallets analyzed" },
  { key: "compareCount", label: "Comparisons" },
  { key: "monitors", label: "Monitors" },
  { key: "populationSize", label: "Observed population" }
];

/** Live aggregate metrics from the backend. Shows "—" when unavailable —
 *  numbers are never fabricated. */
export default function LiveStatsPanel() {
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await getPublicStats();
      if (!cancelled) {
        setStats(s);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="border border-white/10">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="mono-label">AEGIX system · live</span>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-accent-bright">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" aria-hidden="true" />
          {stats ? "Live" : loading ? "Loading" : "Offline"}
        </span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-white/10 sm:grid-cols-5">
        {STATS.map((s) => (
          <div key={s.key} className="px-4 py-4">
            <p className="mono-label text-muted-2">{s.label}</p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-tight text-marble">
              {stats ? fmt(stats[s.key] as number | null) : "—"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
