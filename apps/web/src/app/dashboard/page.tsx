"use client";

import { useCallback, useEffect, useState } from "react";
import { listSavedAnalyses, deleteSavedAnalysis, type SavedAnalysis } from "@/lib/api";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function freshnessLabel(freshUntil: string | null): string {
  if (!freshUntil) return "—";
  const fresh = new Date(freshUntil) > new Date();
  return fresh ? "Fresh" : "Stale";
}

export default function DashboardPage() {
  const [saved, setSaved] = useState<SavedAnalysis[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const items = await listSavedAnalyses();
      setSaved(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load saved wallets");
    }
  }, []);

  useEffect(() => {
    const t = window.localStorage.getItem("aegix_access_token");
    setToken(t);
    void load();
  }, [load]);

  async function remove(address: string) {
    await deleteSavedAnalysis(address);
    setSaved((cur) => (cur ?? []).filter((s) => s.wallet_address !== address));
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-slate-400">Your saved wallets and their latest analysis state.</p>
        </div>
        <a href="/" className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:border-accent">
          New Analysis
        </a>
      </header>

      {!token && (
        <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
          You are browsing anonymously.{" "}
          <a href="/?login=1" className="underline">
            Sign in
          </a>{" "}
          to save wallets and see your dashboard.
        </div>
      )}

      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}

      {saved === null && !error ? (
        <p className="mt-10 text-center text-slate-400">Loading…</p>
      ) : saved?.length === 0 ? (
        <div className="mt-10 rounded-xl border border-slate-700 bg-slate-900 p-8 text-center">
          <p className="text-slate-300">No saved wallets yet.</p>
          <a href="/" className="mt-4 inline-block rounded-lg bg-accent px-5 py-2.5 font-semibold text-white hover:opacity-90">
            Analyze a wallet
          </a>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {saved?.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4">
              <div className="min-w-0">
                <a href={`/analyze/${s.wallet_address}`} className="font-mono text-slate-100 hover:text-accent">
                  {s.label ? `${s.label} · ` : ""}
                  {shortAddress(s.wallet_address)}
                </a>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  {s.score != null && (
                    <span>
                      Score <span className="font-semibold text-slate-300">{s.score}</span>
                    </span>
                  )}
                  {s.confidence != null && (
                    <span>
                      Confidence <span className="font-semibold text-slate-300">{Math.round(Number(s.confidence) * 100)}%</span>
                    </span>
                  )}
                  <span>
                    Status <span className="font-semibold text-slate-300">{s.status ?? "—"}</span>
                  </span>
                  <span>
                    Freshness <span className="font-semibold text-slate-300">{freshnessLabel(s.fresh_until)}</span>
                  </span>
                  {s.last_analyzed_at && (
                    <span>Last analyzed {new Date(s.last_analyzed_at).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <a
                  href={`/analyze/${s.wallet_address}`}
                  className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent"
                >
                  View
                </a>
                <button
                  onClick={() => void remove(s.wallet_address)}
                  className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
