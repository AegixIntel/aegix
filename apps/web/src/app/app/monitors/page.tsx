"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listMonitors, createMonitor, deleteMonitor, type Monitor } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
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
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createMonitor(address.trim(), schedule);
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
    <div className="container-page py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-marble">Privacy Monitors</h1>
          <p className="mt-1 text-sm text-muted-foreground">Continuously re-analyze wallets and get alerted to meaningful exposure changes.</p>
        </div>
      </header>

      {!user && (
        <div className="mt-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
          Connect a Solana wallet to create monitors. Signing in is free — it does not create a transaction and does not cost SOL.
        </div>
      )}

      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}

      {/* Create monitor */}
      <section className="mt-6">
        <form onSubmit={(e) => void create(e)} className="card-surface p-5">
          <h2 className="text-sm font-semibold text-marble">Create Monitor</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <label className="block text-xs text-muted-foreground">
              Solana wallet address
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Enter a Solana address"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-marble outline-none focus:border-accent"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Schedule
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="mt-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-marble outline-none focus:border-accent"
              >
                <option value="DAILY">Daily</option>
                <option value="EVERY_12_HOURS">Every 12h</option>
                <option value="EVERY_6_HOURS">Every 6h</option>
              </select>
            </label>
            <button type="submit" disabled={busy || address.trim().length < 32} className="btn-primary px-5 py-2 text-xs">
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
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-10 text-center">
            <p className="text-sm text-muted-foreground">No monitors yet.</p>
            <p className="text-xs text-muted-foreground/70">Monitor a wallet to track meaningful privacy exposure changes.</p>
            <Link href="/app/analyze" className="btn-primary mt-2 px-5 py-2.5 text-xs">Analyze a wallet first</Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {monitors?.map((m) => (
              <div key={m.id} className="card-surface flex flex-col gap-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/app/monitor/${m.id}`} className="truncate font-mono text-sm text-marble hover:text-accent">
                    {m.label ? `${m.label} · ` : ""}
                    {shortAddress(m.wallet_address)}
                  </Link>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadge(m.status)}`}>{m.status}</span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {m.score != null && (<span>Exposure <span className="font-semibold text-marble/90">{m.score}</span></span>)}
                  {m.next_check_at && <span>Next {new Date(m.next_check_at).toLocaleString()}</span>}
                </div>
                <div className="flex gap-2">
                  <Link href={`/app/monitor/${m.id}`} className="btn-secondary px-3 py-1.5 text-xs">Open</Link>
                  <button onClick={() => void remove(m.id)} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10">
                    Delete
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
