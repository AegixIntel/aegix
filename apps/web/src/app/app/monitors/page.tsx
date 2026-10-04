"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listMonitors, createMonitor, deleteMonitor, saveAnalysis, type Monitor } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function statusBadge(status: string): string {
  switch (status) {
    case "ACTIVE": return "bg-emerald-500/10 text-emerald-800";
    case "PAUSED": return "bg-amber-500/10 text-amber-800";
    case "ENTITLEMENT_PAUSED": return "bg-violet-500/10 text-violet-700";
    case "DEGRADED": return "bg-orange-500/10 text-orange-700";
    case "ERROR": return "bg-red-500/10 text-red-700";
    case "DISABLED": return "bg-ink/[0.05] text-muted-foreground";
    default: return "bg-ink/[0.05] text-muted-foreground";
  }
}

export default function MonitorsPage() {
  const { user } = useAuth();
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // create form
  const [address, setAddress] = useState("");
  const [schedule, setSchedule] = useState("DAILY");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const m = await listMonitors();
      setMonitors(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load monitors");
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setMonitors([]);
      setError(null);
      return;
    }
    void load();
  }, [load, user]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const wallet = address.trim();
      // The API only monitors wallets on the user's saved list and otherwise
      // answers WALLET_NOT_SAVED. Saving is an idempotent upsert.
      await saveAnalysis(wallet);
      await createMonitor(wallet, schedule);
      setAddress("");
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteMonitor(id);
      setMonitors((cur) => (cur ?? []).filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="premium-workspace min-h-screen px-5 py-8 md:px-10 md:py-12 lg:px-14 lg:py-16">
      <div className="mx-auto max-w-[86rem]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 pb-5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-2">
        <span>Intelligence / <span className="text-accent-ink">Surveillance console</span></span>
        <span className="flex items-center gap-2"><span className="live-dot h-1.5 w-1.5 bg-accent" />Exposure watch</span>
      </div>
      <header className="mt-12 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="max-w-4xl">
          <p className="section-label-accent">Privacy monitors</p>
          <h1 className="mt-5 font-display text-5xl font-medium leading-[0.98] tracking-[-0.045em] text-ink md:text-7xl">Know when the<br />signal changes.</h1>
          <p className="mt-7 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">Continuously re-analyze wallets and get alerted to meaningful exposure changes.</p>
        </div>
        <div className="grid grid-cols-2 border border-ink/10 bg-ink/[0.04] lg:w-80">
          <div className="border-r border-ink/10 p-4"><p className="mono-label">Active</p><p className="mt-2 font-mono text-2xl text-ink">{monitors?.filter((m) => m.status === "ACTIVE").length ?? "—"}</p></div>
          <div className="p-4"><p className="mono-label">Total</p><p className="mt-2 font-mono text-2xl text-ink">{monitors?.length ?? "—"}</p></div>
        </div>
      </header>

      {!user && (
        <div className="mt-8 border border-amber-600/30 bg-amber-500/10 p-4 text-sm text-amber-800">
          Connect a Solana wallet to create monitors. Signing in is free — it does not create a transaction and does not cost SOL.
        </div>
      )}

      {error && (
        <div role="alert" className="mt-5 border border-red-600/30 bg-red-500/10 px-4 py-3 text-sm text-red-700">
          <span className="mr-2 font-mono text-[9px] uppercase tracking-[0.16em] text-red-700">Monitor service</span>
          {error}
        </div>
      )}

      {/* Create monitor */}
      <section className="mt-10">
        <form onSubmit={(e) => void create(e)} className="analysis-command-panel border border-ink/10 bg-ink/[0.05] p-5 md:p-7">
          <div className="flex items-center justify-between"><h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-2">Create monitor</h2><span className="font-mono text-[9px] uppercase tracking-wider text-accent-ink">Automated watch</span></div>
          <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <label className="block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
              Solana wallet address
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Enter a Solana address"
                className="analysis-input mt-3 w-full border border-ink/15 bg-paper/80 px-4 py-3.5 font-mono text-sm normal-case tracking-normal text-ink outline-none placeholder:text-muted-2"
              />
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
              Schedule
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="analysis-input mt-3 h-[50px] border border-ink/15 bg-paper/80 px-4 text-sm normal-case tracking-normal text-ink outline-none"
              >
                <option value="DAILY">Daily</option>
                <option value="EVERY_12_HOURS">Every 12h</option>
                <option value="EVERY_6_HOURS">Every 6h</option>
              </select>
            </label>
            <button type="submit" disabled={!user || busy || address.trim().length < 32} className="btn-primary h-[50px] min-w-44">
              {busy ? "Creating…" : "Create monitor"}
            </button>
          </div>
        </form>
      </section>

      {/* List */}
      <section className="mt-8">
        {monitors === null && !error ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : monitors?.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-ink/10 bg-ink/[0.02] p-10 text-center">
            <p className="text-sm text-muted-foreground">No monitors yet.</p>
            <p className="text-xs text-muted-foreground/70">Monitor a wallet to track meaningful privacy exposure changes.</p>
            <Link href="/app/analyze" className="btn-primary mt-2 px-5 py-2.5 text-xs">Analyze a wallet first</Link>
          </div>
        ) : (
          <div className="premium-results grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {monitors?.map((m) => (
              <div key={m.id} className="luxury-panel flex flex-col gap-4 border border-ink/10 bg-ink/[0.04] p-5">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/app/monitor/${m.id}`} className="truncate font-mono text-sm text-ink hover:text-accent-ink">
                    {m.label ? `${m.label} · ` : ""}
                    {shortAddress(m.wallet_address)}
                  </Link>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadge(m.status)}`}>{m.status === "ENTITLEMENT_PAUSED" ? "Plan paused" : m.status}</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {m.score != null && (<span>Exposure <span className="font-semibold text-ink/90">{m.score}</span></span>)}
                  {m.next_check_at && <span>Next {new Date(m.next_check_at).toLocaleString()}</span>}
                </div>
                {m.status === "ENTITLEMENT_PAUSED" && (
                  <p className="text-xs text-violet-700/90">
                    Paused because your plan&apos;s monitor limit no longer covers it. Nothing was deleted; it resumes when your plan has room.
                  </p>
                )}
                <div className="flex gap-2">
                  <Link href={`/app/monitor/${m.id}`} className="btn-secondary px-3 py-1.5 text-xs">Open</Link>
                  <button onClick={() => void remove(m.id)} className="rounded-lg border border-red-600/40 px-3 py-1.5 text-xs text-red-700 hover:bg-red-500/10">
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      </div>
    </div>
  );
}
