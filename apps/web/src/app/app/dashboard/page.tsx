"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listSavedAnalyses, deleteSavedAnalysis, listMonitors, listSavedComparisons, deleteSavedComparison, type SavedAnalysis, type Monitor, type SavedComparison } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";

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
    case "ACTIVE": return "bg-emerald-500/10 text-emerald-800";
    case "PAUSED": return "bg-amber-500/10 text-amber-800";
    case "DEGRADED": return "bg-orange-500/10 text-orange-700";
    case "ERROR": return "bg-red-500/10 text-red-700";
    case "DISABLED": return "bg-ink/[0.05] text-muted-foreground";
    default: return "bg-ink/[0.05] text-muted-foreground";
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
    <div className="container-page py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your saved wallets, monitors, and intelligence.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/app/notifications" className="btn-secondary px-4 py-2 text-xs">Notifications</Link>
        </div>
      </header>

      {!user && (
        <div className="mt-6 rounded-xl border border-amber-600/40 bg-amber-500/10 p-4 text-sm text-amber-800">
          You are browsing anonymously. Connect a Solana wallet to save wallets, monitor them, and see your
          dashboard. Signing in is free — it does not create a transaction and does not cost SOL.{" "}
          <Link href="/app/analyze" className="underline">Analyze a wallet</Link>.
        </div>
      )}

      {error && <p className="mt-6 text-sm text-red-700">{error}</p>}

      {/* Monitored wallets */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Monitored Wallets</h2>
          <span className="text-xs text-muted-foreground">{monitors?.filter((m) => m.status === "ACTIVE" || m.status === "DEGRADED").length ?? 0} active</span>
        </div>
        {monitors === null && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : monitors?.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-ink/10 bg-ink/[0.02] p-8 text-center">
            <p className="text-sm text-muted-foreground">No monitored wallets yet.</p>
            <Link href="/app/analyze" className="btn-primary px-5 py-2.5 text-xs">Monitor a wallet</Link>
            <p className="text-xs text-muted-foreground/70">Analyze a wallet, then enable monitoring to track privacy exposure changes.</p>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {monitors?.map((m) => (
              <Link
                key={m.id}
                href={`/app/monitor/${m.id}`}
                className="card-surface flex flex-col gap-2 p-4 transition hover:border-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm text-ink">
                    {m.label ? `${m.label} · ` : ""}
                    {shortAddress(m.wallet_address)}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadge(m.status)}`}>{m.status}</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {m.score != null && (<span>Exposure <span className="font-semibold text-ink/90">{m.score}</span></span>)}
                  {m.confidence != null && (<span>Confidence <span className="font-semibold text-ink/90">{Math.round(Number(m.confidence) * 100)}%</span></span>)}
                  {m.last_checked_at && <span>Checked {new Date(m.last_checked_at).toLocaleDateString()}</span>}
                  {m.next_check_at && <span>Next {new Date(m.next_check_at).toLocaleString()}</span>}
                </div>
                {Number(m.unread_notifications) > 0 && (
                  <span className="self-start rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold text-accent-ink">
                    {m.unread_notifications} unread alert{Number(m.unread_notifications) === 1 ? "" : "s"}
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Saved comparisons */}
      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Saved Comparisons</h2>
          <Link href="/app/compare" className="text-xs text-muted-foreground hover:text-accent-ink">Compare wallets →</Link>
        </div>
        {comparisons === null && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : comparisons?.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-ink/10 bg-ink/[0.02] p-8 text-center">
            <p className="text-sm text-muted-foreground">No saved comparisons yet.</p>
            <Link href="/app/compare" className="btn-primary px-5 py-2.5 text-xs">Compare two wallets</Link>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {comparisons?.map((c) => (
              <div key={c.id} className="card-surface flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/app/saved/${c.id}`} className="font-mono text-ink hover:text-accent-ink">
                    {c.label ? `${c.label} · ` : ""}
                    {shortAddress(c.wallet_a)} vs {shortAddress(c.wallet_b)}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {c.correlation_score != null && (<span>Correlation <span className="font-semibold text-ink/90">{c.correlation_score}</span></span>)}
                    {c.confidence != null && (<span>Confidence <span className="font-semibold text-ink/90">{Math.round(Number(c.confidence) * 100)}%</span></span>)}
                    {c.classification && (<span>Class <span className="font-semibold text-ink/90">{c.classification.replace(/_/g, " ").toLowerCase()}</span></span>)}
                    <span>Saved {new Date(c.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link href={`/app/saved/${c.id}`} className="btn-secondary px-3 py-1.5 text-xs">Open</Link>
                  <button
                    onClick={() => void removeComparison(c.id)}
                    className="rounded-lg border border-red-600/40 px-3 py-1.5 text-xs text-red-700 hover:bg-red-500/10"
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
        <h2 className="text-lg font-semibold text-ink">Saved Wallets</h2>
        {saved === null && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : saved?.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-ink/10 bg-ink/[0.02] p-8 text-center">
            <p className="text-sm text-muted-foreground">No saved wallets yet.</p>
            <Link href="/app/analyze" className="btn-primary px-5 py-2.5 text-xs">Analyze a wallet</Link>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {saved?.map((s) => (
              <div key={s.id} className="card-surface flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/app/analyze/${s.wallet_address}`} className="font-mono text-ink hover:text-accent-ink">
                    {s.label ? `${s.label} · ` : ""}
                    {shortAddress(s.wallet_address)}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {s.score != null && (<span>Score <span className="font-semibold text-ink/90">{s.score}</span></span>)}
                    {s.confidence != null && (<span>Confidence <span className="font-semibold text-ink/90">{Math.round(Number(s.confidence) * 100)}%</span></span>)}
                    <span>Status <span className="font-semibold text-ink/90">{s.status ?? "—"}</span></span>
                    <span>Freshness <span className="font-semibold text-ink/90">{freshnessLabel(s.fresh_until)}</span></span>
                    {s.last_analyzed_at && (<span>Last analyzed {new Date(s.last_analyzed_at).toLocaleDateString()}</span>)}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link href={`/app/analyze/${s.wallet_address}`} className="btn-secondary px-3 py-1.5 text-xs">View</Link>
                  <button
                    onClick={() => void remove(s.wallet_address)}
                    className="rounded-lg border border-red-600/40 px-3 py-1.5 text-xs text-red-700 hover:bg-red-500/10"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
