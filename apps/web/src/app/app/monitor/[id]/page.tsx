"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  getMonitorDetail,
  updateMonitor,
  deleteMonitor,
  acknowledgeEvent,
  type Monitor,
  type AlertRules,
  type ThreatEvent
} from "@/lib/api";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "CRITICAL": return "bg-red-500/15 text-red-700";
    case "HIGH": return "bg-orange-500/15 text-orange-700";
    case "MEDIUM": return "bg-amber-500/15 text-amber-800";
    case "LOW": return "bg-sky-500/15 text-sky-700";
    default: return "bg-ink/[0.07] text-muted-foreground";
  }
}

export default function MonitorDetailPage() {
  const params = useParams<{ id: string }>();
  const monitorId = params.id;

  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [rules, setRules] = useState<AlertRules | null>(null);
  const [events, setEvents] = useState<ThreatEvent[]>([]);
  const [checks, setChecks] = useState<Array<Record<string, unknown>>>([]);
  const [diffs, setDiffs] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const detail = await getMonitorDetail(monitorId);
      setMonitor(detail.monitor);
      setRules(detail.rules);
      setEvents(detail.events);
      setChecks(detail.checks);
      setDiffs(detail.diffs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load monitor");
    }
  }, [monitorId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(p: { scheduleType?: string; status?: string; alertRules?: {
    minimumSeverity?: string;
    minimumConfidence?: number;
    overallScoreDeltaThreshold?: number;
    notifyNewEntity?: boolean;
    notifyNewAttackPath?: boolean;
    notifyDataQualityDegraded?: boolean;
    cooldownHours?: number;
  } }) {
    setError(null);
    try {
      const result = await updateMonitor(monitorId, p);
      setMonitor(result.monitor);
      setRules(result.rules);
    } catch (err) {
      // A resume can be refused at the plan's monitor limit
      // (MONITOR_LIMIT_REACHED); show why instead of failing silently.
      setError(err instanceof Error ? err.message : "Failed to update monitor");
    }
  }

  async function disable() {
    await deleteMonitor(monitorId);
    setMonitor((m) => (m ? { ...m, status: "DISABLED" } : m));
  }

  const latestDiff = diffs[0] as
    | (Record<string, unknown> & { overall_change?: { delta?: number; previous?: number; current?: number } })
    | undefined;

  return (
    <div className="container-page py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/app/dashboard" className="text-xs text-muted-foreground hover:text-accent-ink">← Dashboard</Link>
          <h1 className="mt-1 font-display text-2xl font-semibold text-ink">
            {monitor?.label ? `${monitor.label} · ` : ""}
            <span className="font-mono">{monitor ? shortAddress(monitor.wallet_address) : "Monitor"}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Status <span className="font-semibold text-ink/90">{monitor?.status ?? "—"}</span>
            {" · "}Schedule <span className="font-semibold text-ink/90">{monitor?.schedule_type ?? "—"}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void patch({ status: monitor?.status === "PAUSED" || monitor?.status === "ENTITLEMENT_PAUSED" ? "ACTIVE" : "PAUSED" })}
            className="btn-secondary px-4 py-2 text-xs"
          >
            {monitor?.status === "PAUSED" || monitor?.status === "ENTITLEMENT_PAUSED" ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => void disable()}
            className="rounded-lg border border-red-600/40 px-4 py-2 text-xs text-red-700 hover:bg-red-500/10"
          >
            Disable
          </button>
        </div>
      </header>

      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}

      {/* Current exposure + change */}
      <section className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="card-surface p-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Current Exposure</p>
          <p className="mt-1 text-4xl font-bold text-ink">{monitor?.score ?? "—"}</p>
          {monitor?.confidence != null && (
            <p className="text-xs text-muted-foreground">Confidence {Math.round(Number(monitor.confidence) * 100)}%</p>
          )}
        </div>
        <div className="card-surface p-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Exposure Change (latest diff)</p>
          {latestDiff?.overall_change ? (
            <>
              <p className={`mt-1 text-4xl font-bold ${(latestDiff.overall_change.delta ?? 0) > 0 ? "text-red-700" : "text-emerald-800"}`}>
                {latestDiff.overall_change.delta! > 0 ? "+" : ""}{latestDiff.overall_change.delta}
              </p>
              <p className="text-xs text-muted-foreground">
                {latestDiff.overall_change.previous} → {latestDiff.overall_change.current}
              </p>
            </>
          ) : (
            <p className="mt-1 text-4xl font-bold text-muted-foreground/40">—</p>
          )}
        </div>
        <div className="card-surface p-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Next Check</p>
          <p className="mt-1 text-sm font-semibold text-ink/90">{monitor?.next_check_at ? new Date(monitor.next_check_at).toLocaleString() : "—"}</p>
          <p className="text-xs text-muted-foreground">
            Last checked {monitor?.last_checked_at ? new Date(monitor.last_checked_at).toLocaleString() : "never"}
          </p>
        </div>
      </section>

      {/* Monitor settings + alert rules */}
      <section className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="card-surface p-5">
          <h2 className="text-sm font-semibold text-ink">Monitor Settings</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {["DAILY", "EVERY_12_HOURS", "EVERY_6_HOURS"].map((s) => (
              <button
                key={s}
                onClick={() => void patch({ scheduleType: s })}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  monitor?.schedule_type === s ? "border-accent bg-accent/20 text-accent-ink" : "border-ink/20 text-muted-foreground hover:border-accent"
                }`}
              >
                {s.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
        <div className="card-surface p-5">
          <h2 className="text-sm font-semibold text-ink">Alert Rules</h2>
          <p className="mt-1 text-xs text-muted-foreground/80">
            In-app alerts are delivered automatically and appear on the{" "}
            <Link href="/app/notifications" className="text-accent-ink hover:underline">Notifications</Link> page.
          </p>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <label className="flex items-center justify-between gap-2">
              <span>Minimum severity</span>
              <select
                value={rules?.minimum_severity ?? "HIGH"}
                onChange={(e) => void patch({ alertRules: { minimumSeverity: e.target.value } })}
                className="rounded border border-ink/20 bg-ink/[0.06] px-2 py-1 text-ink/90"
              >
                {["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Minimum confidence ({(Number(rules?.minimum_confidence ?? 0.6) * 100).toFixed(0)}%)</span>
              <input
                type="range"
                min={0}
                max={95}
                value={String(Math.round(Number(rules?.minimum_confidence ?? 0.6) * 100))}
                onChange={(e) => void patch({ alertRules: { minimumConfidence: Number(e.target.value) / 100 } })}
                className="w-32 accent-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Score delta threshold ({rules?.overall_score_delta_threshold ?? 10})</span>
              <input
                type="range"
                min={0}
                max={50}
                value={String(rules?.overall_score_delta_threshold ?? 10)}
                onChange={(e) => void patch({ alertRules: { overallScoreDeltaThreshold: Number(e.target.value) } })}
                className="w-32 accent-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Notify on new entity exposure</span>
              <input
                type="checkbox"
                checked={rules?.notify_new_entity ?? true}
                onChange={(e) => void patch({ alertRules: { notifyNewEntity: e.target.checked } })}
                className="accent-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Notify on new attack path</span>
              <input
                type="checkbox"
                checked={rules?.notify_new_attack_path ?? true}
                onChange={(e) => void patch({ alertRules: { notifyNewAttackPath: e.target.checked } })}
                className="accent-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Notify on data quality degradation</span>
              <input
                type="checkbox"
                checked={rules?.notify_data_quality_degraded ?? true}
                onChange={(e) => void patch({ alertRules: { notifyDataQualityDegraded: e.target.checked } })}
                className="accent-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span>Cooldown hours ({rules?.cooldown_hours ?? 24})</span>
              <input
                type="number"
                min={1}
                max={168}
                value={rules?.cooldown_hours ?? 24}
                onChange={(e) => void patch({ alertRules: { cooldownHours: Number(e.target.value) } })}
                className="w-20 rounded border border-ink/20 bg-ink/[0.06] px-2 py-1 text-ink/90"
              />
            </label>
          </div>
        </div>
      </section>

      {/* Threat event feed */}
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-ink">Threat Events</h2>
        {events.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-2 rounded-xl border border-dashed border-ink/10 bg-ink/[0.02] p-8 text-center text-sm text-muted-foreground">
            No threat events yet. Events appear when a scheduled check finds a meaningful exposure change.
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {events.map((e) => (
              <div key={e.id} className="card-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{e.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.event_type} · {new Date(e.created_at).toLocaleString()} ·{" "}
                      {Number(e.occurrence_count) > 1 && `seen ${e.occurrence_count}x · `}
                      state {e.state}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${severityColor(e.severity)}`}>{e.severity}</span>
                    <span className="text-xs text-muted-foreground">{Math.round(Number(e.confidence) * 100)}%</span>
                    {e.state !== "ACKNOWLEDGED" && (
                      <button
                        onClick={() => void acknowledgeEvent(e.id).then(load)}
                        className="rounded border border-ink/20 px-2 py-0.5 text-[10px] text-muted-foreground hover:border-accent"
                      >
                        Acknowledge
                      </button>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  className="mt-1 text-xs text-accent-ink hover:underline"
                >
                  {expanded === e.id ? "Hide evidence" : "Show evidence"}
                </button>
                {expanded === e.id && (
                  <div className="mt-2 rounded-lg bg-paper-raised p-3 text-xs text-muted-foreground">
                    <p>{e.explanation}</p>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(e.evidence, null, 2)}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent checks */}
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-ink">Analysis Timeline</h2>
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          {checks.length === 0 && <p className="text-muted-foreground/70">No checks recorded yet.</p>}
          {checks.map((c) => (
            <div key={String(c.id)} className="flex flex-wrap justify-between gap-2 rounded-lg border border-ink/5 bg-ink/[0.02] px-3 py-2">
              <span>{new Date(String(c.created_at ?? "")).toLocaleString()}</span>
              <span className="font-semibold text-ink/90">{String(c.status)}</span>
              {c.delay_ms != null && <span>delayed {String(c.delay_ms)}ms</span>}
              {Boolean(c.analysis_id) && <span className="font-mono">analysis {String(c.analysis_id).slice(0, 8)}</span>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
