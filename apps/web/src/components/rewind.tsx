"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getRewindSubjects, rewind, type RewindReconstruction, type RewindResponse, type RewindSubject, type RewindSubjectType } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";

const LOOKBACKS = [24, 48, 72, 168];
/** Time between two checkpoints of the signal replay appearing. */
const REPLAY_STEP_MS = 450;
/** Shown until the API's list arrives, and if it cannot be loaded. */
const DEFAULT_SUBJECTS: RewindSubject[] = ["BTC", "ETH", "SOL"].map((subject) => ({ subject, label: subject, kind: "MARKET_ASSET" }));
const lead = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

/** Default event time: now, in the local form a datetime-local input expects. */
function localNow(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * The hours AEGIX stored nothing for, run through the engine when the page
 * was asked for. Drawn apart from the replay, with a broken border, because
 * it is not a record and must not be read as one.
 */
function Reconstruction({ reconstruction }: { reconstruction: RewindReconstruction }) {
  const slots = Math.max(4, ...reconstruction.checkpoints.map((c) => c.signalTypesSoFar.length));
  return <div className="rounded-lg border border-dashed border-ink/40 p-5">
    <p className="text-xs uppercase tracking-[0.12em] text-accent">Reconstructed · not a stored record</p>
    <h2 className="mt-1 text-lg text-ink">{reconstruction.answer}</h2>
    <p className="mt-2 text-xs text-muted-foreground">Hours from {reconstruction.from} to {reconstruction.to}, where AEGIX stored no capture · {reconstruction.hours} hours with a price · computed {reconstruction.computedAt} with {reconstruction.engineVersion} · read from {reconstruction.sources.join(", ")}</p>
    <ol className="mt-4 space-y-2 font-mono text-sm">{reconstruction.checkpoints.map((checkpoint) => <li key={checkpoint.label} className="flex flex-wrap items-center gap-3">
      <span className="w-16 text-muted-foreground">{checkpoint.label}</span>
      <span aria-label={`${checkpoint.signalTypesSoFar.length} signal types reconstructed`} className="tracking-widest text-ink/70">
        {Array.from({ length: slots }, (_, i) => i < checkpoint.signalTypesSoFar.length ? "◆" : "◇").join(" ")}
      </span>
      <span className="text-xs text-muted-2">{checkpoint.capturesSoFar === 0 ? "no hour reconstructed yet" : checkpoint.signalTypesSoFar.join(", ") || "reconstructed, no signal"}</span>
    </li>)}</ol>
    <ul className="mt-4 text-xs text-muted-2">{reconstruction.limitations.map((text) => <li key={text} className="mt-1">{text}</li>)}</ul>
  </div>;
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
  /** Checkpoints of the signal replay shown so far, and a counter that restarts it. */
  const [revealed, setRevealed] = useState(0);
  const [playback, setPlayback] = useState(0);

  // A link can name the replay: /app/rewind?subject=SOL&eventTime=<ISO>&lookback=72.
  // It fills the form in; the press is still the visitor's.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const subject = params.get("subject")?.trim();
    if (subject) {
      // A Solana address is 32 to 44 characters; no asset symbol is that long.
      if (subject.length >= 32) { setSubjectType("wallet"); setWallet(subject.slice(0, 44)); }
      else setAsset(subject);
    }
    const at = new Date(params.get("eventTime") ?? "");
    if (!Number.isNaN(at.getTime())) setEventTime(new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    const lookback = Number(params.get("lookback"));
    if (LOOKBACKS.includes(lookback)) setLookbackHours(lookback);
  }, []);

  // The replay is played, oldest checkpoint first, as the record filled in.
  useEffect(() => {
    if (!data) return;
    const total = data.checkpoints.length;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setRevealed(total); return; }
    let shown = 0;
    setRevealed(0);
    const timer = setInterval(() => {
      shown += 1;
      setRevealed(shown);
      if (shown >= total) clearInterval(timer);
    }, REPLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [data, playback]);

  useEffect(() => {
    let cancelled = false;
    getRewindSubjects().then((list) => { if (!cancelled && list.length > 0) setSubjects(list); }).catch(() => { /* the default list stays */ });
    return () => { cancelled = true; };
  }, []);

  async function load() {
    const current = ++generation.current;
    setLoading(true); setError(null); setData(null); setRevealed(0);
    try {
      const result = await rewind({ subjectType, subject: subjectType === "asset" ? asset : wallet.trim(), eventTime: new Date(eventTime).toISOString(), lookbackHours });
      if (current === generation.current) setData(result);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : "Rewind unavailable"); }
    finally { if (current === generation.current) setLoading(false); }
  }

  /** The button answers the press at once, also while the session is still being restored. */
  async function submit() {
    setLoading(true);
    if (!(await requireAuth(load))) setLoading(false);
  }

  const slots = data ? Math.max(4, ...data.checkpoints.map((c) => c.signalTypesSoFar.length)) : 4;
  return <main className="mx-auto max-w-5xl px-4 py-8">
    <h1 className="font-display text-2xl font-semibold text-ink">AEGIX Rewind</h1>
    <p className="mt-2 text-sm text-muted-foreground">Go back to before the event and see what AEGIX had already stored. A replay reads captures exactly as they were recorded; nothing is recomputed, and nothing stored at or after the event time is shown. An observable signal is not a prediction.</p>
    <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
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
      </div>
      <div><h2 className="text-sm font-semibold text-ink/80">Signal replay
          {revealed >= data.checkpoints.length ? <button type="button" className="ml-3 text-xs font-normal text-muted-foreground underline decoration-ink/30 underline-offset-2 hover:decoration-accent" onClick={() => setPlayback((n) => n + 1)}>Play again</button> : null}
        </h2>
        <ol className="mt-3 space-y-2 font-mono text-sm">{data.checkpoints.map((checkpoint, index) => {
          const shown = index < revealed;
          return <li key={checkpoint.label} className={`flex flex-wrap items-center gap-3 transition-opacity duration-300 ${shown ? "" : "opacity-40"}`}>
            <span className="w-16 text-muted-foreground">{checkpoint.label}</span>
            <span aria-label={`${checkpoint.signalTypesSoFar.length} signal types stored`} className="tracking-widest text-ink">
              {Array.from({ length: slots }, (_, i) => shown && i < checkpoint.signalTypesSoFar.length ? "●" : "○").join(" ")}
            </span>
            {shown ? <span className="text-xs text-muted-2">{checkpoint.capturesSoFar === 0 ? "no capture stored yet" : checkpoint.signalTypesSoFar.join(", ") || "captured, no signal"}</span> : null}
          </li>;
        })}</ol>
        {data.convergence && revealed >= data.checkpoints.length ? <p className="mt-3 font-mono text-sm text-ink">Convergence stored {lead(data.convergence.leadSeconds)} before the event: {data.convergence.signalTypes.join(", ")}.</p> : null}
      </div>
      {data.discoveries.length ? <div><h2 className="text-sm font-semibold text-ink/80">Relationships already on record</h2>
        <p className="mt-1 text-xs text-muted-2">Discoveries on this subject&apos;s series that the Discovery Engine had stamped before the event, with the status each had then.</p>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">{data.discoveries.map((discovery) => <li key={discovery.id}>
          <span className="font-mono text-xs text-ink/80">Discovery #{discovery.id} · {discovery.status.replace("_", " ")} · stamped {lead(discovery.leadSeconds)} before the event</span>
          <span className="block">{discovery.title}</span>
        </li>)}</ul>
        <Link href="/app/discoveries" className="mt-3 inline-block text-xs text-muted-foreground underline decoration-ink/30 underline-offset-2 hover:decoration-accent">Open the Discovery Engine →</Link>
      </div> : null}
      <details className="rounded-lg border border-ink/10 p-4"><summary className="cursor-pointer text-sm text-ink/80">Stored captures · {data.timeline.length}</summary>
        <ul className="mt-3 space-y-3">{data.timeline.map((capture) => <li key={capture.id} className="text-xs text-muted-foreground">
          <p className="text-ink/80">{capture.observedAt} · {capture.engineVersion} · quality {capture.qualityGrade} · {capture.providerStatus}</p>
          {capture.signals.length === 0 ? <p>No signal met its threshold.</p> : capture.signals.map((signal, i) => <p key={`${signal.type}:${i}`}>{signal.type} · severity {signal.severity} · confidence {(signal.confidence * 100).toFixed(0)}% · {signal.engineVersion} — {signal.summary}</p>)}
        </li>)}</ul>
      </details>
      <ul className="text-xs text-muted-2">{data.limitations.map((text) => <li key={text} className="mt-1">{text}</li>)}</ul>
      <p className="text-xs text-muted-2">Engines at capture time: {data.engineVersions.join(", ") || "none"} · {data.rewindEngineVersion}</p>
      {data.reconstruction ? <Reconstruction reconstruction={data.reconstruction} /> : null}
    </section> : null}
  </main>;
}
