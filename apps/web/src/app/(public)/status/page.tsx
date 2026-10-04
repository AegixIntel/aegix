"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/api";
import { SectionLabel, EditorialHeading, ErrorState } from "@/components/ui/primitives";

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

  const statusColor = health?.status === "ok" ? "text-emerald-800" : health?.status === "degraded" ? "text-amber-800" : "text-red-700";

  return (
    <div className="container-narrow py-20 md:py-28">
      <SectionLabel>Status</SectionLabel>
      <EditorialHeading as="h1" className="mt-6">
        System status
      </EditorialHeading>
      <p className="mt-6 editorial-body">Live service health, refreshed on load.</p>

      <div className="mt-12">
        {loading ? (
          <div className="border border-ink/10 p-8 text-center text-sm text-muted-foreground">Checking services…</div>
        ) : error ? (
          <ErrorState
            title="Status Unavailable"
            message={error}
            retry={() => void load()}
          />
        ) : health ? (
          <div className="border border-ink/10 p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className={`font-display text-2xl font-semibold ${statusColor}`}>
                  {health.status === "ok" ? "Operational" : health.status === "degraded" ? "Degraded" : "Unavailable"}
                </p>
                <p className="text-xs text-muted-2">AEGIX public services</p>
              </div>
              <button onClick={() => void load()} className="btn-secondary px-3 py-1.5 text-xs">
                Refresh
              </button>
            </div>
            <dl className="mt-6 divide-y divide-ink/10">
              {Object.entries(CHECK_LABELS).map(([key, label]) => {
                const ok = health.checks[key];
                return (
                  <div key={key} className="flex items-center justify-between py-3">
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="flex items-center gap-2 text-sm">
                      <span
                        className={`inline-flex h-2 w-2 rounded-full ${ok === true ? "bg-emerald-600" : ok === false ? "bg-red-600" : "bg-amber-600"}`}
                        aria-hidden="true"
                      />
                      <span className={ok === true ? "text-emerald-800" : ok === false ? "text-red-700" : "text-amber-800"}>
                        {ok === true ? "OK" : ok === false ? "Down" : "Unknown"}
                      </span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ) : null}
      </div>

      <p className="mt-8 text-xs text-muted-2">
        If a service is degraded, cached intelligence remains available. AEGIX never exposes internal hostnames
        or credentials on this page.
      </p>
    </div>
  );
}
