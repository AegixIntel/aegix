"use client";

import { useCallback, useEffect, useState } from "react";
import { getWalletContext, type ContextIndicator, type WalletContext } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";
import AskAegix from "@/components/ask-aegix";

const SUPPRESSION_COPY: Record<string, string> = {
  ABSENCE_NOT_EVIDENCE:
    "Reported an absence of observations. Absence within a bounded history says nothing about the wallet, so it is not shown as a finding.",
  AGGREGATE_OF_LISTED_EVIDENCE:
    "Derived from indicators already listed. Showing it again would count the same evidence twice.",
  INSUFFICIENT_ACTIVITY:
    "Measures a distribution the sample is too small to support. Withheld rather than reported weakly."
};

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

export default function WalletContextPage({ initialAddress = "" }: { initialAddress?: string }) {
  const { requireAuth } = useRequireAuth();
  const [address, setAddress] = useState(initialAddress);
  const [data, setData] = useState<WalletContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ContextIndicator | null>(null);

  const load = useCallback(
    async (target: string) => {
      if (!target) return;
      setLoading(true);
      setError(null);
      setSelected(null);
      try {
        setData(await getWalletContext(target));
      } catch (err) {
        setData(null);
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (initialAddress) void load(initialAddress);
  }, [initialAddress, load]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header>
        <h1 className="font-display text-2xl font-semibold text-marble">Wallet Context</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Contextual indicators assembled from the deterministic intelligence AEGIX already produced for this
          wallet. Every indicator names the engine that produced it. Nothing here is a verdict about the wallet
          or the people behind it.
        </p>
      </header>

      <form
        className="mt-6 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void requireAuth(() => load(address.trim()));
        }}
      >
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Solana wallet address"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm text-slate-100"
        />
        <button type="submit" className="btn-primary px-5 py-2 text-sm" disabled={loading}>
          {loading ? "Loading…" : "Load context"}
        </button>
      </form>

      {error ? (
        <p className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {data ? (
        <section className="mt-8 space-y-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
            <span className="font-mono text-sm text-slate-300">{shortAddress(data.wallet)}</span>
            <span className="text-xs text-slate-500">
              {data.coverage.transactionsParsed} transactions analysed
              {data.coverage.grade ? ` · dataset graded ${data.coverage.grade}` : ""}
              {" · "}
              {data.engineVersions.context}
            </span>
          </div>

          {data.sufficiency === "INSUFFICIENT_ACTIVITY" ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              Too little activity for statistical measures. Observed events are still listed; behavioural and
              transaction-pattern measures were withheld rather than computed from too small a sample.
            </p>
          ) : null}

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Indicators</h2>
            {data.indicators.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">
                No indicator met the evidence bar for this analysis. That is not a statement that the wallet is
                free of exposure.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.indicators.map((indicator) => {
                  const band = severityLabel(indicator.severity);
                  return (
                    <li key={indicator.id}>
                      <button
                        onClick={() => setSelected(selected?.id === indicator.id ? null : indicator)}
                        className="w-full rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 text-left hover:border-white/20"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm text-slate-100">{indicator.title}</span>
                          <span className={`text-xs font-semibold ${band.color}`}>{band.label}</span>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {indicator.category} · {indicator.sourceEngine} {indicator.engineVersion} · confidence{" "}
                          {(indicator.confidence * 100).toFixed(0)}%
                        </div>
                        {selected?.id === indicator.id ? (
                          <div className="mt-3 border-t border-white/10 pt-3">
                            <p className="text-sm text-slate-300">{indicator.description}</p>
                            <p className="mt-2 font-mono text-xs text-slate-500">{indicator.id} · {indicator.evidenceRefs?.join(", ")}</p>
                            {indicator.evidence.length > 0 ? (
                              <dl className="mt-3 grid gap-1 text-xs">
                                {indicator.evidence.map((e) => (
                                  <div key={e.key} className="flex justify-between gap-4">
                                    <dt className="text-slate-500">{e.label}</dt>
                                    <dd className="font-mono text-slate-300">{String(e.value)}</dd>
                                  </div>
                                ))}
                              </dl>
                            ) : null}
                          </div>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Identity linkability</h2>
            <p className="mt-3 text-sm text-slate-300">
              {data.linkability.converged
                ? `Convergence observed across ${data.linkability.contributingCategories.join(", ")}.`
                : "No convergence across independent evidence classes."}
            </p>
            <p className="mt-2 text-xs text-slate-500">{data.linkability.note}</p>
          </div>

          {data.supportingEvidence?.length ? <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Persisted supporting evidence</h2>
            <p className="mt-2 text-xs text-slate-500">These paths and comparisons provide context for existing indicators. They are not additional independent findings.</p>
            <ul className="mt-3 space-y-3">{data.supportingEvidence.map((entry) => <li key={entry.id} className="rounded-lg border border-white/10 p-4">
              <h3 className="text-sm text-slate-200">{entry.title}</h3><p className="mt-2 text-sm text-slate-400">{entry.description}</p>
              <p className="mt-2 text-xs text-slate-500">{entry.id} · {entry.sourceEngine} {entry.engineVersion} · confidence {(entry.confidence * 100).toFixed(0)}% · observed {entry.observedAt} · {entry.analysisId ? "this analysis" : "separate persisted window"}</p>
              <details className="mt-2 text-xs text-slate-400"><summary>Evidence references</summary>{entry.evidence.map((item) => <p className="mt-1 break-all" key={item.key}>{item.label}: {String(item.value)}</p>)}</details>
              {entry.limitations.map((text) => <p key={text} className="mt-2 text-xs text-slate-500">{text}</p>)}
            </li>)}</ul>
          </div> : null}

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Known-risk check</h2>
            <p className="mt-3 text-sm text-slate-300">
              Dataset {data.knownRisk.dataset} · result {data.knownRisk.match}
            </p>
            <p className="mt-2 text-xs text-slate-500">{data.knownRisk.note}</p>
          </div>

          {data.suppressed.length > 0 ? (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                Withheld ({data.suppressed.length})
              </h2>
              <p className="mt-2 text-xs text-slate-500">
                Shown so that a quiet wallet is distinguishable from a quiet engine.
              </p>
              <ul className="mt-3 space-y-2">
                {data.suppressed.map((s) => (
                  <li key={s.id} className="rounded-lg border border-white/5 bg-white/[0.01] px-4 py-3">
                    <div className="font-mono text-xs text-slate-400">{s.signalType}</div>
                    <p className="mt-1 text-xs text-slate-500">{SUPPRESSION_COPY[s.reason] ?? s.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <AskAegix wallet={data.wallet} />

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Limitations</h2>
            <ul className="mt-3 space-y-2 text-xs text-slate-500">
              {data.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </main>
  );
}
