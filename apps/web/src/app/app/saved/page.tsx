"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listSavedAnalyses, listSavedComparisons, type SavedAnalysis, type SavedComparison } from "@/lib/api";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export default function SavedPage() {
  const [wallets, setWallets] = useState<SavedAnalysis[] | null>(null);
  const [comparisons, setComparisons] = useState<SavedComparison[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [w, c] = await Promise.all([listSavedAnalyses(), listSavedComparisons()]);
      setWallets(w);
      setComparisons(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load saved");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="container-page py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-marble">Saved</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your saved wallets and comparisons.</p>
        </div>
        <Link href="/app/analyze" className="btn-secondary px-4 py-2 text-xs">New Analysis</Link>
      </header>

      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}

      {/* Saved comparisons */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-marble">Saved Comparisons</h2>
        {comparisons === null && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : comparisons?.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center">
            <p className="text-sm text-muted-foreground">No saved comparisons yet.</p>
            <Link href="/app/compare" className="btn-primary px-5 py-2.5 text-xs">Compare two wallets</Link>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {comparisons?.map((c) => (
              <div key={c.id} className="card-surface flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/app/saved/${c.id}`} className="font-mono text-marble hover:text-accent">
                    {c.label ? `${c.label} · ` : ""}
                    {shortAddress(c.wallet_a)} vs {shortAddress(c.wallet_b)}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {c.correlation_score != null && <span>Correlation <span className="font-semibold text-marble/90">{c.correlation_score}</span></span>}
                    {c.confidence != null && <span>Confidence <span className="font-semibold text-marble/90">{Math.round(Number(c.confidence) * 100)}%</span></span>}
                  </div>
                </div>
                <Link href={`/app/saved/${c.id}`} className="btn-secondary px-3 py-1.5 text-xs">Open</Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Saved wallets */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold text-marble">Saved Wallets</h2>
        {wallets === null && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : wallets?.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center">
            <p className="text-sm text-muted-foreground">No saved wallets yet.</p>
            <Link href="/app/analyze" className="btn-primary px-5 py-2.5 text-xs">Analyze a wallet</Link>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {wallets?.map((s) => (
              <div key={s.id} className="card-surface flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/app/analyze/${s.wallet_address}`} className="font-mono text-marble hover:text-accent">
                    {s.label ? `${s.label} · ` : ""}
                    {shortAddress(s.wallet_address)}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {s.score != null && <span>Score <span className="font-semibold text-marble/90">{s.score}</span></span>}
                    <span>Status <span className="font-semibold text-marble/90">{s.status ?? "—"}</span></span>
                  </div>
                </div>
                <Link href={`/app/analyze/${s.wallet_address}`} className="btn-secondary px-3 py-1.5 text-xs">Open</Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
