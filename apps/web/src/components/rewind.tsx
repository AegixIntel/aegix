"use client";

import { useEffect, useRef, useState } from "react";
import { getRewindSubjects, rewind, type RewindResponse, type RewindSubject, type RewindSubjectType } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";

const LOOKBACKS = [24, 48, 72, 168];
/** Shown until the API's list arrives, and if it cannot be loaded. */
const DEFAULT_SUBJECTS: RewindSubject[] = ["BTC", "ETH", "SOL"].map((subject) => ({ subject, label: subject, kind: "MARKET_ASSET" }));
const lead = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

/** Default event time: now, in the local form a datetime-local input expects. */
function localNow(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function Rewind() {
  const [subjectType, setSubjectType] = useState<RewindSubjectType>("asset");
  const [asset, setAsset] = useState("SOL");
  const [wallet, setWallet] = useState("");
  const [eventTime, setEventTime] = useState(localNow);
  const [lookbackHours, setLookbackHours] = useState(72);
  const [data, setData] = useState<RewindResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [subjects, setSubjects] = useState<RewindSubject[]>(DEFAULT_SUBJECTS);
  const generation = useRef(0);
  const { requireAuth } = useRequireAuth();

  useEffect(() => {
    let cancelled = false;
    getRewindSubjects().then((list) => { if (!cancelled && list.length > 0) setSubjects(list); }).catch(() => { /* the default list stays */ });
    return () => { cancelled = true; };
  }, []);

  async function load() {
    const current = ++generation.current;
    setLoading(true); setError(null); setData(null);
    try {
      const result = await rewind({ subjectType, subject: subjectType === "asset" ? asset : wallet.trim(), eventTime: new Date(eventTime).toISOString(), lookbackHours });
      if (current === generation.current) setData(result);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : "Rewind unavailable"); }
    finally { if (current === generation.current) setLoading(false); }
  }

  const slots = data ? Math.max(4, ...data.checkpoints.map((c) => c.signalTypesSoFar.length)) : 4;
  return <main className="mx-auto max-w-5xl px-4 py-8">
    <h1 className="font-display text-2xl font-semibold text-ink">AEGIX Rewind</h1>
    <p className="mt-2 text-sm text-muted-foreground">Go back to before the event and see what AEGIX had already stored. A replay reads captures exactly as they were recorded; nothing is recomputed, and nothing stored at or after the event time is shown. An observable signal is not a prediction.</p>
    <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void requireAuth(load); }}>
      <label className="text-sm text-ink/80">Subject
        <select aria-label="Subject type" value={subjectType} onChange={(e) => { generation.current++; setData(null); setSubjectType(e.target.value as RewindSubjectType); }} className="ml-2 rounded-lg border border-ink/10 bg-paper px-3 py-2">
          <option value="asset">Asset</option><option value="wallet">Solana wallet</option>
        </select>
      </label>
      {subjectType === "asset"
        ? <select aria-label="Asset" value={asset} onChange={(e) => setAsset(e.target.value)} className="min-w-0 max-w-full rounded-lg border border-ink/10 bg-paper px-3 py-2 text-sm">
            {subjects.map((item) => <option key={item.subject} value={item.subject}>{item.label}</option>)}
          </select>
        : <input aria-label="Solana wallet" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Solana wallet address" spellCheck={false} maxLength={44} className="min-w-0 flex-1 rounded-lg border border-ink/10 bg-ink/[0.03] px-3 py-2 text-sm text-ink" />}
      <label className="text-sm text-ink/80">Event time
        <input aria-label="Event time" type="datetime-local" value={eventTime} onChange={(e) => setEventTime(e.target.value)} className="ml-2 rounded-lg border border-ink/10 bg-ink/[0.03] px-3 py-2 text-sm text-ink" />
      </label>
      <label className="text-sm text-ink/80">Rewind
        <select aria-label="Lookback" value={lookbackHours} onChange={(e) => setLookbackHours(Number(e.target.value))} className="ml-2 rounded-lg border border-ink/10 bg-paper px-3 py-2">
          {LOOKBACKS.map((hours) => <option key={hours} value={hours}>{hours} hours before</option>)}
        </select>
      </label>
      <button className="btn-primary px-4 py-2 text-sm" disabled={loading || !eventTime || (subjectType === "wallet" && !wallet.trim())}>{loading ? "Replaying…" : "Could AEGIX have seen it?"}</button>
    </form>
    {error ? <p role="alert" className="mt-6 text-sm text-amber-800">{error}</p> : null}
    {data ? <section className="mt-8 space-y-6">
      <div className="rounded-lg border border-ink/10 p-5">
        <p className="text-xs text-muted-2">{data.verdict.replaceAll("_", " ")}</p>
        <h2 className="mt-1 text-lg text-ink">{data.answer}</h2>
        <p className="mt-2 text-xs text-muted-foreground">Locked at {data.lockedAt} · window from {data.windowStart} · {data.coverage.captures} stored captures{data.coverage.excludedByLock ? ` · ${data.coverage.excludedByLock} refused by the lock` : ""}</p>
        {data.convergence ? <p className="mt-2 text-sm text-ink/80">Convergence stored {lead(data.convergence.leadSeconds)} before the event: {data.convergence.signalTypes.join(", ")}.</p> : null}
      </div>
      <div><h2 className="text-sm font-semibold text-ink/80">Signal replay</h2>
        <ol className="mt-3 space-y-2 font-mono text-sm">{data.checkpoints.map((checkpoint) => <li key={checkpoint.label} className="flex flex-wrap items-center gap-3">
          <span className="w-16 text-muted-foreground">{checkpoint.label}</span>
          <span aria-label={`${checkpoint.signalTypesSoFar.length} signal types stored`} className="tracking-widest text-ink">
            {Array.from({ length: slots }, (_, i) => i < checkpoint.signalTypesSoFar.length ? "●" : "○").join(" ")}
          </span>
          <span className="text-xs text-muted-2">{checkpoint.capturesSoFar === 0 ? "no capture stored yet" : checkpoint.signalTypesSoFar.join(", ") || "captured, no signal"}</span>
        </li>)}</ol>
      </div>
      <details className="rounded-lg border border-ink/10 p-4"><summary className="cursor-pointer text-sm text-ink/80">Stored captures · {data.timeline.length}</summary>
        <ul className="mt-3 space-y-3">{data.timeline.map((capture) => <li key={capture.id} className="text-xs text-muted-foreground">
          <p className="text-ink/80">{capture.observedAt} · {capture.engineVersion} · quality {capture.qualityGrade} · {capture.providerStatus}</p>
          {capture.signals.length === 0 ? <p>No signal met its threshold.</p> : capture.signals.map((signal, i) => <p key={`${signal.type}:${i}`}>{signal.type} · severity {signal.severity} · confidence {(signal.confidence * 100).toFixed(0)}% · {signal.engineVersion} — {signal.summary}</p>)}
        </li>)}</ul>
      </details>
      <ul className="text-xs text-muted-2">{data.limitations.map((text) => <li key={text} className="mt-1">{text}</li>)}</ul>
      <p className="text-xs text-muted-2">Engines at capture time: {data.engineVersions.join(", ") || "none"} · {data.rewindEngineVersion}</p>
    </section> : null}
  </main>;
}
