"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/api";

interface HealthReady {
  status: "ok" | "degraded" | "unavailable";
  checks: Record<string, boolean>;
}

const CHECK_LABELS: Record<string, string> = {
  postgres: "Database",
  redis: "Cache / Queue",
  queue: "Background workers",
  rpc: "Solana RPC",
  monitoring: "Monitoring",
  email: "Email delivery"
};

export default function StatusPage() {
  const [health, setHealth] = useState<HealthReady | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/health/ready`);
      if (!res.ok) throw new Error(`Health check failed (${res.status})`);
      const body = (await res.json()) as HealthReady;
      setHealth(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reach status service");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const statusColor =
    health?.status === "ok" ? "text-emerald-400" : health?.status === "degraded" ? "text-amber-400" : "text-red-400";
  const statusLabel =
    health?.status === "ok" ? "Operational" : health?.status === "degraded" ? "Degraded" : "Unavailable";

  return (
    <div className="container-page py-16">
      <div className="mx-auto max-w-2xl text-center">
        <p className="marketing-eyebrow">Status</p>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-marble md:text-5xl">
          System status
        </h1>
        <p className="marketing-body mt-4">Live service health, refreshed on load.</p>
      </div>

      <section className="mx-auto mt-10 max-w-2xl">
        {loading ? (
          <div className="card-surface p-8 text-center">
            <p className="text-sm text-muted-foreground">Checking services…</p>
          </div>
        ) : error ? (
          <div className="card-surface border-red-500/40 p-8 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={() => void load()} className="btn-secondary mt-4 px-5 py-2 text-xs">Retry</button>
          </div>
        ) : health ? (
          <div className="card-surface p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className={`font-display text-2xl font-semibold ${statusColor}`}>{statusLabel}</p>
                <p className="text-xs text-muted-foreground">AEGIX public services</p>
              </div>
              <button onClick={() => void load()} className="btn-secondary px-3 py-1.5 text-xs">Refresh</button>
            </div>
            <dl className="mt-6 space-y-2">
              {Object.entries(CHECK_LABELS).map(([key, label]) => {
                const ok = health.checks[key];
                return (
                  <div key={key} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="flex items-center gap-2 text-sm">
                      <span
                        className={`inline-flex h-2 w-2 rounded-full ${
                          ok === true ? "bg-emerald-400" : ok === false ? "bg-red-400" : "bg-amber-400"
                        }`}
                        aria-hidden="true"
                      />
                      <span className={ok === true ? "text-emerald-400" : ok === false ? "text-red-400" : "text-amber-300"}>
                        {ok === true ? "OK" : ok === false ? "Down" : "Unknown"}
                      </span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ) : null}
      </section>

      <p className="mx-auto mt-8 max-w-2xl text-center text-xs text-muted-foreground/70">
        If a service is degraded, cached intelligence remains available. AEGIX never exposes internal hostnames or
        credentials on this page.
      </p>
    </div>
  );
}
