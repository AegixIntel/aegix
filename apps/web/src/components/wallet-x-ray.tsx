"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getWalletXRay, getLatestAnalysis, saveAnalysis, type WalletXRay, type XRaySignal } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import { useRequireAuth } from "@/lib/auth-guard";
import AnalysisTracker from "@/components/analysis-tracker";

const IN_PROGRESS_STAGES = new Set([
  "CREATED", "QUEUED", "FETCHING", "NORMALIZING", "ENTITY_ANALYSIS",
  "RELATIONSHIP_ANALYSIS", "BEHAVIOR_ANALYSIS", "SCORING", "GRAPH_ANALYSIS",
  "EXPLANATION", "PERSISTING"
]);

function severityLabel(score: number): { label: string; color: string } {
  if (score < 20) return { label: "MINIMAL", color: "text-emerald-400" };
  if (score < 40) return { label: "LOW", color: "text-lime-400" };
  if (score < 60) return { label: "MODERATE", color: "text-amber-400" };
  if (score < 80) return { label: "HIGH", color: "text-orange-400" };
  return { label: "VERY HIGH", color: "text-red-400" };
}

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export default function WalletXRayPage({ wallet }: { wallet: string }) {
  const { user } = useAuth();
  const { requireAuth } = useRequireAuth();
  const [data, setData] = useState<WalletXRay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSignal, setSelectedSignal] = useState<XRaySignal | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [trackingId, setTrackingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const xray = await getWalletXRay(wallet);
      setData(xray);
      setTrackingId(null);
      setSelectedSignal((cur) => cur ?? xray.topSignals[0] ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load analysis";
      if (message === "NO_ANALYSIS") {
        // Report isn't ready yet — check whether an analysis is running.
        const latest = await getLatestAnalysis(wallet).catch(() => null);
        const status = latest?.status;
        if (status && IN_PROGRESS_STAGES.has(status)) {
          setError(null);
          setTrackingId(latest.latestAnalysisId ?? null);
        } else {
          setError(message);
        }
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }

  function handleSave() {
    void requireAuth(async () => {
      setSaveError(null);
      try {
        await saveAnalysis(wallet);
        setSaved(true);
      } catch {
        setSaveError("Failed to save this wallet to your dashboard.");
      }
    });
  }

  const handleTrackerComplete = useCallback(() => {
    void load();
  }, [load]);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-400">Loading analysis…</div>;
  }

  if (trackingId) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-2xl font-semibold text-marble">Analyzing wallet…</h1>
        <p className="mt-3 max-w-md text-muted-foreground">
          AEGIX is fetching and analyzing this wallet&apos;s public activity. This is the real pipeline —
          status reflects the backend stage.
        </p>
        <div className="mt-6 w-full max-w-md">
          <AnalysisTracker analysisId={trackingId} onComplete={handleTrackerComplete} />
        </div>
      </main>
    );
  }

  if (error === "NO_ANALYSIS") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-bold">No analysis yet</h1>
        <p className="mt-3 max-w-md text-slate-400">
          This wallet has not been analyzed. Start an analysis to generate a Wallet X-Ray report.
        </p>
        <Link
          href={`/app/analyze?address=${encodeURIComponent(wallet)}`}
          className="btn-primary mt-6"
        >
          Analyze this wallet
        </Link>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-bold text-red-400">Failed to load analysis</h1>
        <p className="mt-3 text-slate-400">{error}</p>
        <button onClick={() => void load()} className="mt-6 rounded-lg bg-accent px-5 py-2.5 font-semibold text-white hover:opacity-90">
          Retry
        </button>
      </main>
    );
  }

  const score = data.score;
  const severity = score ? severityLabel(score.overall) : { label: "—", color: "text-slate-500" };
  const coverage = data.coverage;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <button onClick={() => void copyAddress()} className="font-mono text-lg text-slate-100 hover:text-accent" title="Copy address">
            {shortAddress(wallet)}
            <span className="ml-2 text-xs text-slate-500">{copied ? "copied" : "copy"}</span>
          </button>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>Status: {data.analysis.status}</span>
            <span>Last analyzed: {data.analysis.completedAt ? new Date(data.analysis.completedAt).toLocaleString() : "—"}</span>
            <span>Transactions: {coverage.transactionsAnalyzed ?? coverage.transactionsParsed ?? "—"}</span>
            <span>History: {coverage.historyCoverageDays != null ? `${coverage.historyCoverageDays} days` : "—"}</span>
            {coverage.parserSuccessRate != null && <span>Parser: {coverage.parserSuccessRate}%</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/app/analyze?address=${encodeURIComponent(wallet)}`}
            className="btn-secondary px-4 py-2 text-xs"
          >
            Refresh Analysis
          </Link>
          <button
            onClick={handleSave}
            disabled={saved}
            className="btn-secondary px-4 py-2 text-xs disabled:opacity-40"
          >
            {saved ? "Saved" : user ? "Save Wallet" : "Sign in to save"}
          </button>
        </div>
      </header>
      {saveError && <p className="mt-2 text-xs text-amber-400">{saveError}</p>}

      {/* Data coverage (D2 §76) */}
      <section className="mt-8 rounded-xl border border-slate-700 bg-slate-900 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500">Data Coverage</p>
            <div className="mt-2 flex items-end gap-3">
              <span className="text-5xl font-bold">{coverage.dataQualityScore ?? "—"}</span>
              <span className="pb-1 text-xl text-slate-500">/ 100</span>
              {coverage.grade && (
                <span
                  className={`mb-1 rounded px-2 py-0.5 text-xs font-bold ${
                    coverage.grade === "HIGH"
                      ? "bg-emerald-500/10 text-emerald-400"
                      : coverage.grade === "MEDIUM"
                        ? "bg-amber-500/10 text-amber-400"
                        : "bg-red-500/10 text-red-400"
                  }`}
                >
                  {coverage.grade}
                </span>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">Transactions analyzed</dt>
              <dd className="font-semibold text-slate-200">{coverage.transactionsAnalyzed ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">History</dt>
              <dd className="font-semibold text-slate-200">
                {coverage.historyCoverageDays != null ? `${coverage.historyCoverageDays} days` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Parser success</dt>
              <dd className="font-semibold text-slate-200">
                {coverage.parserSuccessRate != null ? `${coverage.parserSuccessRate}%` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Semantic understanding</dt>
              <dd className="font-semibold text-slate-200">
                {coverage.semanticCoverage != null ? `${coverage.semanticCoverage}%` : "—"}
              </dd>
            </div>
          </dl>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Data quality measures how much confidence AEGIX can place in this dataset — it is separate from the exposure
          score.
        </p>
      </section>

      {/* Primary score */}
      {score && (
        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
            <p className="text-xs uppercase tracking-widest text-slate-500">Privacy Exposure</p>
            <div className="mt-2 flex items-end gap-3">
              <span className="text-6xl font-bold">{score.overall}</span>
              <span className="pb-2 text-2xl text-slate-500">/ 100</span>
            </div>
            <p className={`mt-2 text-lg font-semibold ${severity.color}`}>{severity.label}</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-6">
            <p className="text-xs uppercase tracking-widest text-slate-500">Analysis Confidence</p>
            <div className="mt-2 flex items-end gap-3">
              <span className="text-6xl font-bold text-sky-400">{Math.round(score.confidence * 100)}</span>
              <span className="pb-2 text-2xl text-slate-500">%</span>
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Exposure and confidence are separate: a high score with low confidence means limited data.
            </p>
            <p className="mt-1 text-xs text-slate-600">Scoring: {score.scoringVersion ?? "—"}</p>
          </div>
        </section>
      )}

      {/* Seven dimensions */}
      {data.dimensions.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">Exposure Dimensions</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.dimensions.map((dim) => {
              const sev = severityLabel(dim.score);
              return (
                <div key={dim.key} className="rounded-lg border border-slate-700 bg-slate-900 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-300">{dim.label}</p>
                    <span className={`text-xs font-semibold ${sev.color}`}>{sev.label}</span>
                  </div>
                  <p className="mt-2 text-3xl font-bold">{dim.score}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Top findings + evidence explorer */}
      {data.topSignals.length > 0 && (
        <section className="mt-8 grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">Top Findings</h2>
            <div className="mt-3 space-y-2">
              {data.topSignals.map((signal) => {
                const sev = severityLabel(signal.severity);
                const active = selectedSignal?.type === signal.type;
                return (
                  <button
                    key={signal.type}
                    onClick={() => setSelectedSignal(signal)}
                    className={`w-full rounded-lg border p-4 text-left transition ${
                      active ? "border-accent bg-slate-800" : "border-slate-700 bg-slate-900 hover:border-slate-500"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-slate-100">{signal.title}</p>
                      <span className={`text-xs font-bold ${sev.color}`}>{sev.label}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-400">
                      Confidence {Math.round(signal.confidence * 100)}% · {signal.category}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {selectedSignal && (
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">Evidence</h2>
              <p className="mt-3 font-semibold text-slate-100">{selectedSignal.title}</p>
              <div className="mt-1 flex gap-4 text-xs text-slate-500">
                <span>
                  Severity <span className={severityLabel(selectedSignal.severity).color}>{severityLabel(selectedSignal.severity).label}</span>
                </span>
                <span>Confidence {Math.round(selectedSignal.confidence * 100)}%</span>
              </div>
              {selectedSignal.explanation && <p className="mt-3 text-sm leading-relaxed text-slate-300">{selectedSignal.explanation}</p>}
              {selectedSignal.evidence.length > 0 && (
                <dl className="mt-4 space-y-2 border-t border-slate-700 pt-4">
                  {selectedSignal.evidence.map((ev) => (
                    <div key={ev.key} className="flex justify-between gap-4 text-sm">
                      <dt className="text-slate-500">{ev.label}</dt>
                      <dd className="font-mono text-slate-200">{String(ev.value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
        </section>
      )}

      {/* Attack paths */}
      {data.attackPaths.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">Attack My Wallet — Strongest Paths</h2>
          <div className="mt-3 space-y-3">
            {data.attackPaths.slice(0, 5).map((path) => (
              <div key={path.rank} className="rounded-lg border border-slate-700 bg-slate-900 p-4">
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                  <span className="rounded bg-slate-800 px-2 py-0.5 font-semibold text-slate-300">#{path.rank}</span>
                  <span>Score {Math.round(path.pathScore * 100)}</span>
                  <span>Confidence {Math.round(path.confidence * 100)}%</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-sm">
                  {path.nodes.map((node, i) => (
                    <span key={`${node.label}-${i}`} className="flex items-center gap-2">
                      {i > 0 && <span className="text-slate-600">→</span>}
                      <span className={node.type === "ENTITY" ? "text-amber-300" : "text-slate-200"}>{shortAddress(node.label)}</span>
                    </span>
                  ))}
                </div>
                {path.explanation && <p className="mt-2 text-sm text-slate-400">{path.explanation}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Potential wallet correlations (D5-I §45-§48) */}
      {data.correlations && data.correlations.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">Potential Wallet Correlations</h2>
          <p className="mt-1 text-xs text-slate-500">Qualifying persisted correlations — observable linkability, not ownership.</p>
          <div className="mt-3 space-y-2">
            {data.correlations.map((c) => (
              <div key={c.wallet} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-slate-200">{shortAddress(c.wallet)}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {c.classification.replace(/_/g, " ").toLowerCase()} · strength {c.score}/100 · confidence {Math.round(c.confidence * 100)}%
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-600">{c.families.join(" + ")}</p>
                </div>
                <a
                  href={`/app/compare?a=${encodeURIComponent(wallet)}&b=${encodeURIComponent(c.wallet)}`}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                >
                  Compare
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.topSignals.length === 0 && (
        <p className="mt-10 text-center text-sm text-slate-500">No significant exposure signals found for this wallet.</p>
      )}
    </main>
  );
}
