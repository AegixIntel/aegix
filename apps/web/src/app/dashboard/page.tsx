"use client";

import { useCallback, useEffect, useState } from "react";
import { listSavedAnalyses, deleteSavedAnalysis, listMonitors, listSavedComparisons, deleteSavedComparison, type SavedAnalysis, type Monitor, type SavedComparison } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import WalletAuthButton from "@/components/wallet-auth-button";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function freshnessLabel(freshUntil: string | null): string {
  if (!freshUntil) return "—";
  const fresh = new Date(freshUntil) > new Date();
  return fresh ? "Fresh" : "Stale";
}

function statusBadge(status: string): string {
  switch (status) {
    case "ACTIVE": return "bg-emerald-500/10 text-emerald-400";
    case "PAUSED": return "bg-amber-500/10 text-amber-400";
    case "DEGRADED": return "bg-orange-500/10 text-orange-400";
    case "ERROR": return "bg-red-500/10 text-red-400";
    case "DISABLED": return "bg-slate-600/10 text-slate-400";
    default: return "bg-slate-600/10 text-slate-400";
  }
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [saved, setSaved] = useState<SavedAnalysis[] | null>(null);
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [comparisons, setComparisons] = useState<SavedComparison[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [items, mon, cmp] = await Promise.all([listSavedAnalyses(), listMonitors(), listSavedComparisons()]);
      setSaved(items);
      setMonitors(mon);
      setComparisons(cmp);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(address: string) {
    await deleteSavedAnalysis(address);
    setSaved((cur) => (cur ?? []).filter((s) => s.wallet_address !== address));
  }

  async function removeComparison(id: string) {
    await deleteSavedComparison(id);
    setComparisons((cur) => (cur ?? []).filter((c) => c.id !== id));
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-slate-400">Your saved wallets and their latest analysis state.</p>
        </div>
        <div className="flex gap-2">
          <WalletAuthButton />
          <a href="/dashboard/notifications" className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:border-accent">
            Notifications
          </a>
          <a href="/developer" className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:border-accent">
            Developer API
          </a>
          <a href="/" className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:border-accent">
            New Analysis
          </a>
        </div>
      </header>

      {!user && (
        <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
          You are browsing anonymously. Connect a Solana wallet to save wallets, monitor them, and see your
          dashboard. Signing in is free — it does not create a transaction and does not cost SOL.
        </div>
      )}

      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}

      {/* Monitored wallets (D4-G §56) */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Monitored Wallets</h2>
          <span className="text-xs text-slate-500">{monitors?.filter((m) => m.status === "ACTIVE" || m.status === "DEGRADED").length ?? 0} active</span>
        </div>
        {monitors === null && !error ? (
          <p className="mt-4 text-sm text-slate-400">Loading…</p>
        ) : monitors?.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-6 text-center text-sm text-slate-400">
            No monitored wallets yet. Save a wallet, then enable monitoring from its dashboard.
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {monitors?.map((m) => (
              <a
                key={m.id}
                href={`/dashboard/monitor/${m.id}`}
                className="flex flex-col gap-2 rounded-xl border border-slate-700 bg-slate-900 p-4 hover:border-accent"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm text-slate-100">
                    {m.label ? `${m.label} · ` : ""}
                    {shortAddress(m.wallet_address)}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadge(m.status)}`}>{m.status}</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  {m.score != null && (
                    <span>
                      Exposure <span className="font-semibold text-slate-300">{m.score}</span>
                    </span>
                  )}
                  {m.confidence != null && (
                    <span>
                      Confidence <span className="font-semibold text-slate-300">{Math.round(Number(m.confidence) * 100)}%</span>
                    </span>
                  )}
                  {m.last_checked_at && <span>Checked {new Date(m.last_checked_at).toLocaleDateString()}</span>}
                  {m.next_check_at && <span>Next {new Date(m.next_check_at).toLocaleString()}</span>}
                </div>
                {Number(m.unread_notifications) > 0 && (
                  <span className="self-start rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    {m.unread_notifications} unread alert{Number(m.unread_notifications) === 1 ? "" : "s"}
                  </span>
                )}
              </a>
            ))}
          </div>
        )}
      </section>

      {/* Saved comparisons (D6-A §23) */}
      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Saved Comparisons</h2>
          <a href="/compare" className="text-xs text-slate-500 hover:text-accent">Compare wallets →</a>
        </div>
        {comparisons === null && !error ? (
          <p className="mt-4 text-sm text-slate-400">Loading…</p>
        ) : comparisons?.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-8 text-center">
            <p className="text-slate-300">No saved comparisons yet.</p>
            <a href="/compare" className="mt-4 inline-block rounded-lg bg-accent px-5 py-2.5 font-semibold text-white hover:opacity-90">
              Compare two wallets
            </a>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {comparisons?.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4">
                <div className="min-w-0">
                  <a href={`/dashboard/saved-comparison/${c.id}`} className="font-mono text-slate-100 hover:text-accent">
                    {c.label ? `${c.label} · ` : ""}
                    {shortAddress(c.wallet_a)} vs {shortAddress(c.wallet_b)}
                  </a>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    {c.correlation_score != null && (
                      <span>
                        Correlation <span className="font-semibold text-slate-300">{c.correlation_score}</span>
                      </span>
                    )}
                    {c.confidence != null && (
                      <span>
                        Confidence <span className="font-semibold text-slate-300">{Math.round(Number(c.confidence) * 100)}%</span>
                      </span>
                    )}
                    {c.classification && (
                      <span>
                        Class <span className="font-semibold text-slate-300">{c.classification.replace(/_/g, " ").toLowerCase()}</span>
                      </span>
                    )}
                    <span>Saved {new Date(c.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <a
                    href={`/dashboard/saved-comparison/${c.id}`}
                    className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent"
                  >
                    Open
                  </a>
                  <button
                    onClick={() => void removeComparison(c.id)}
                    className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                  >
                    Unsave
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Saved wallets */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold">Saved Wallets</h2>
        {saved === null && !error ? (
          <p className="mt-4 text-sm text-slate-400">Loading…</p>
        ) : saved?.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-8 text-center">
            <p className="text-slate-300">No saved wallets yet.</p>
            <a href="/" className="mt-4 inline-block rounded-lg bg-accent px-5 py-2.5 font-semibold text-white hover:opacity-90">
              Analyze a wallet
            </a>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
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
      </section>
    </main>
  );
}
