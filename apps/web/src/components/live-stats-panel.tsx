"use client";

import { useEffect, useState } from "react";
import { getPublicStats, type PublicStats } from "@/lib/api";
import { cn } from "@/lib/cn";

function fmt(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const STATS: Array<{ key: keyof PublicStats; label: string }> = [
  { key: "analyses", label: "Analyses" },
  { key: "walletsAnalyzed", label: "Wallets" },
  { key: "compareCount", label: "Comparisons" },
  { key: "monitors", label: "Monitors" },
  { key: "populationSize", label: "Population" }
];

/** Counts up to a real value once it arrives. Never invents a number. */
function CountUp({ value }: { value: number | null }) {
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    if (value === null) {
      setShown(null);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 1100);
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{fmt(shown)}</>;
}

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

  const live = stats !== null;

  return (
    <div className="grid grid-cols-2 gap-px bg-ink/10 sm:grid-cols-3 lg:grid-cols-[minmax(0,1.3fr)_repeat(5,minmax(0,1fr))]">
      <div className="flex items-center gap-2.5 bg-paper px-4 py-5 lg:px-8">
        <span className={cn("h-1.5 w-1.5 rounded-full", live ? "live-dot bg-accent" : "bg-muted-2")} aria-hidden="true" />
        <span className="mono-label">{live ? "AEGIX system · live" : loading ? "Connecting…" : "Stats offline"}</span>
      </div>
      {STATS.map((s) => (
        <div key={s.key} className="bg-paper px-4 py-5">
          <p className="mono-label">{s.label}</p>
          <p className="mt-1.5 font-mono text-2xl font-medium tabular-nums tracking-tight text-ink">
            {stats ? <CountUp value={stats[s.key] as number | null} /> : "—"}
          </p>
        </div>
      ))}
    </div>
  );
}
