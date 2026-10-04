"use client";

import { useCallback, useEffect, useState } from "react";
import { getDeveloperUsage, type DeveloperUsageSummary } from "@/lib/api";

export default function UsageSection() {
  const [usage, setUsage] = useState<DeveloperUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const u = await getDeveloperUsage();
      setUsage(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load usage");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-ink">Usage</h2>
      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
      {usage === null && !error ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : usage ? (
        <div className="card-surface mt-4 p-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Used</p>
              <p className="mt-1 text-xl font-bold text-ink">{usage.used}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Limit</p>
              <p className="mt-1 text-xl font-bold text-ink">{usage.limit}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Remaining</p>
              <p className="mt-1 text-xl font-bold text-emerald-800">{usage.remaining}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Resets</p>
              <p className="mt-1 text-sm font-semibold text-ink/90">{usage.resetAt ? new Date(usage.resetAt).toLocaleString() : "—"}</p>
            </div>
          </div>

          {/* Usage bar */}
          {usage.limit > 0 && (
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-ink/[0.06]">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, Math.round((usage.used / usage.limit) * 100))}%` }}
              />
            </div>
          )}

          {usage.breakdown.length > 0 && (
            <div className="mt-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">By operation</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {usage.breakdown.map((b) => (
                  <li key={b.operation} className="flex justify-between">
                    <span className="font-mono text-xs">{b.operation}</span>
                    <span>{b.units}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-xs text-muted-foreground/70">
            Quota is per user, resets at the period end shown above, and does not multiply across keys.
            This limit is separate from per-request rate limits.
          </p>
        </div>
      ) : null}
    </section>
  );
}
