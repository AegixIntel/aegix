"use client";

import { useCallback, useEffect, useState } from "react";
import { compareWallets, getAccessToken, saveComparison, deleteSavedComparison, type CompareClusterMember, type CompareEvidenceFamily, type ComparePath, type CompareResult, type SavedComparison } from "@/lib/api";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/** D6-I3: population-commonality copy. Exposed so the UI logic is testable
 *  without a DOM; every empirical percentage carries the AEGIX-population
 *  disclaimer (§30) and never claims ownership. */
export function commonalityLabel(treatment: "MEANINGFUL" | "DISCOUNTED" | "HEAVILY_DISCOUNTED" | "STATIC"): string {
  switch (treatment) {
    case "MEANINGFUL": return "MEANINGFUL";
    case "DISCOUNTED": return "DISCOUNTED";
    case "HEAVILY_DISCOUNTED": return "HEAVILY DISCOUNTED";
    default: return "STATIC TREATMENT";
  }
}

export function commonalityFrequencyLabel(note: {
  frequency: number | null;
  populationSize: number | null;
  treatment: "MEANINGFUL" | "DISCOUNTED" | "HEAVILY_DISCOUNTED" | "STATIC";
}): string {
  if (note.frequency === null || note.populationSize === null) return "Not enough AEGIX-observed population to estimate this overlap reliably.";
  return `Observed in ${Math.round(note.frequency * 1000) / 10}% of eligible AEGIX-analyzed wallets (${note.populationSize} wallets).`;
}

export function commonalityWhy(note: {
  treatment: "MEANINGFUL" | "DISCOUNTED" | "HEAVILY_DISCOUNTED" | "STATIC";
  kind: "COUNTERPARTY" | "ENTITY";
}): string {
  switch (note.treatment) {
    case "MEANINGFUL":
      return "This overlap is uncommon in the currently observed AEGIX population, so it contributes meaningfully to the correlation evidence.";
    case "DISCOUNTED":
    case "HEAVILY_DISCOUNTED":
      return note.kind === "ENTITY"
        ? "This entity is common across the observed AEGIX population, so interacting with it provides little evidence of a distinctive relationship."
        : "This counterparty is common across the observed AEGIX population, so the overlap provides little evidence of a distinctive relationship.";
    default:
      return "Population statistics are not available for this key; the static common-activity treatment applies.";
  }
}

function familyLabel(family: string): string {
  const labels: Record<string, string> = {
    FUNDING: "Funding",
    TRANSFER_RELATIONSHIP: "Transfers",
    COUNTERPARTY_OVERLAP: "Counterparties",
    ENTITY_OVERLAP: "Entities",
    BEHAVIORAL_SIMILARITY: "Behavior",
    PROTOCOL_SEQUENCE_SIMILARITY: "Protocol Sequences",
    TEMPORAL_CORRELATION: "Timing"
  };
  return labels[family] ?? family.replace(/_/g, " ").toLowerCase();
}

function strengthBar(strength: number): React.ReactElement {
  const pct = Math.round(strength * 100);
  const color = strength >= 0.6 ? "bg-red-400" : strength >= 0.4 ? "bg-amber-400" : strength >= 0.2 ? "bg-lime-400" : "bg-slate-500";
  return (
    <div className="h-1.5 w-full rounded bg-slate-800">
      <div className={`h-1.5 rounded ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: CompareEvidenceFamily["evidence"] }) {
  if (!evidence || evidence.length === 0) return <p className="text-xs text-slate-500">No inspectable evidence.</p>;
  return (
    <ul className="mt-2 space-y-1 text-xs text-slate-400">
      {evidence.slice(0, 5).map((e, i) => (
        <li key={i} className="flex gap-2">
          <span className="shrink-0 text-slate-600">{e.key}</span>
          <span className="break-all">{e.label}</span>
        </li>
      ))}
    </ul>
  );
}

function FamilyCard({ family }: { family: CompareEvidenceFamily }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{familyLabel(family.family)}</h3>
        <span className="text-xs text-slate-500">{Math.round(family.strength * 100)}% strength</span>
      </div>
      {strengthBar(family.strength)}
      <p className="mt-2 text-xs text-slate-400">Confidence {Math.round(family.confidence * 100)}%</p>
      <p className="mt-1 text-xs text-slate-500">{family.summary}</p>
      <EvidenceList evidence={family.evidence} />
    </div>
  );
}

function PathView({ path }: { path: ComparePath }) {
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <summary className="cursor-pointer text-sm">
        <span className="font-semibold">{path.pathType}</span>
        <span className="ml-2 text-slate-400">
          score {Math.round(path.pathScore * 100)}% · confidence {Math.round(path.confidenceScore * 100)}%
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap items-center gap-1 text-xs text-slate-300">
          {path.nodes.map((n, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-slate-600">→</span>}
              <span
                className={
                  n.type === "ENTITY" || n.type === "PROTOCOL"
                    ? "rounded bg-sky-900/60 px-1.5 py-0.5 text-sky-300"
                    : "rounded bg-slate-800 px-1.5 py-0.5"
                }
              >
                {shortAddress(n.label)}
              </span>
            </span>
          ))}
        </div>
        <ul className="space-y-1 text-xs text-slate-400">
          {path.edges.map((e, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${e.observationClass === "OBSERVED" ? "bg-emerald-900/50 text-emerald-300" : "bg-purple-900/50 text-purple-300"}`}>
                {e.observationClass === "OBSERVED" ? "solid" : "dashed"}
              </span>
              <span>{e.type}</span>
              <span className="text-slate-600">strength {Math.round(e.strength * 100)}% conf {Math.round(e.confidence * 100)}%</span>
            </li>
          ))}
        </ul>
        {path.explanation.map((line, i) => (
          <p key={i} className="text-xs text-slate-500">{line}</p>
        ))}
      </div>
    </details>
  );
}

function ClusterMemberCard({ member }: { member: CompareClusterMember }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{shortAddress(member.wallet)}</span>
        {member.lowData && <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300">low data</span>}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
        <span>strength {Math.round(member.strengthToCore * 100)}%</span>
        <span>confidence {Math.round(member.confidence * 100)}%</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{member.evidenceFamilies.join(" + ")}</p>
    </div>
  );
}

export default function ComparePage({ initialA, initialB }: { initialA?: string; initialB?: string }) {
  const [walletA, setWalletA] = useState(initialA ?? "");
  const [walletB, setWalletB] = useState(initialB ?? "");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (a: string, b: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await compareWallets(a, b);
      setResult(res);
    } catch (err) {
      const e = err as Error & { code?: string };
      setError({ code: e.code, message: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (walletA.trim() && walletB.trim()) void run(walletA.trim(), walletB.trim());
  }

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold">Compare Wallets</h1>
      <p className="mt-1 text-sm text-slate-400">
        Compare two wallets&apos; observable on-chain behavior. Correlation indicates linkability — it never establishes common ownership.
      </p>

      <form onSubmit={submit} className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end">
        <label className="block">
          <span className="text-xs text-slate-500">Wallet A</span>
          <input
            value={walletA}
            onChange={(e) => setWalletA(e.target.value)}
            placeholder="Solana address"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <span className="hidden text-center text-slate-600 sm:pb-2">vs</span>
        <label className="block">
          <span className="text-xs text-slate-500">Wallet B</span>
          <input
            value={walletB}
            onChange={(e) => setWalletB(e.target.value)}
            placeholder="Solana address"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <button
          type="submit"
          disabled={loading || !walletA.trim() || !walletB.trim()}
          className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {loading ? "Comparing…" : "Compare"}
        </button>
      </form>

      {loading && (
        <div className="mt-8 space-y-2 text-sm text-slate-400">
          <p>Loading analyses and correlation…</p>
          <div className="h-1.5 w-full animate-pulse rounded bg-slate-800" />
        </div>
      )}

      {error && (
        <div className="mt-8 rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300">
          <p className="font-semibold">{error.code ?? "COMPARISON_FAILED"}</p>
          <p className="mt-1">{error.message}</p>
          {error.code === "ANALYSIS_REQUIRED" && (
            <p className="mt-2 text-xs text-red-400">Analyze both wallets first — each wallet needs a fresh analysis before comparison.</p>
          )}
        </div>
      )}

      {result && <CompareResultView result={result} onRetry={() => void run(walletA, walletB)} />}
    </main>
  );
}

// ---- D6-A: save/unsave a comparison (authenticated) ----

function SaveComparisonButton({ result }: { result: CompareResult }) {
  const [saved, setSaved] = useState<SavedComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // Refresh saved state when the session changes.
    void (async () => {
      if (!getAccessToken()) return;
      try {
        const row = await saveComparison(result.walletA, result.walletB).catch(() => null);
        if (row) setSaved(row);
      } catch {
        // anonymous: nothing to restore
      }
    })();
  }, [result.walletA, result.walletB]);

  async function toggle() {
    setBusy(true);
    setMessage(null);
    try {
      if (saved) {
        await deleteSavedComparison(saved.id);
        setSaved(null);
      } else {
        const row = await saveComparison(result.walletA, result.walletB);
        setSaved(row);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!getAccessToken()) {
    return (
      <p className="text-xs text-slate-500">
        Connect a wallet to save this comparison.
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => void toggle()}
        disabled={busy}
        className={`rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-40 ${
          saved
            ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
            : "border-slate-600 text-slate-200 hover:border-accent"
        }`}
      >
        {saved ? "Saved" : "Save Comparison"}
      </button>
      {saved && (
        <a href="/dashboard" className="text-xs text-slate-500 underline hover:text-accent">
          View in dashboard
        </a>
      )}
      {message && <p className="text-xs text-red-400">{message}</p>}
    </div>
  );
}

// ---- D6-I3: population commonality in the compare UI ----

function CommonalitySection({ commonality }: { commonality?: CompareResult["commonality"] }) {
  if (!commonality) return null;

  const notes = commonality.notes ?? [];
  const populationActive = commonality.eligible && commonality.source === "POPULATION" && !commonality.stale;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="text-sm font-semibold">Why this shared activity matters</h2>
      <p className="mt-1 text-xs text-slate-500">
        Common counterparties and entities carry less correlation weight than rare ones.
      </p>

      {!populationActive && (
        <div className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200/90">
          <p className="font-semibold">Population commonality unavailable</p>
          <p className="mt-1 text-amber-200/70">
            {commonality.source === "STATIC"
              ? "AEGIX does not yet have enough eligible observations to estimate this overlap reliably — static common-activity treatment applies."
              : "AEGIX population statistics are not fresh or large enough yet — static common-activity treatment applies."}
          </p>
        </div>
      )}

      {notes.length === 0 && populationActive && (
        <p className="mt-3 text-xs text-slate-500">No shared counterparties or entities with population observations in this comparison.</p>
      )}

      {notes.length > 0 && (
        <ul className="mt-3 space-y-2">
          {notes.map((note) => (
            <li key={`${note.kind}-${note.key}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="break-all text-sm font-medium text-slate-200">
                  {note.kind === "ENTITY" && note.name ? note.name : shortAddress(note.key)}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                    note.treatment === "MEANINGFUL"
                      ? "bg-emerald-900/50 text-emerald-300"
                      : note.treatment === "HEAVILY_DISCOUNTED"
                        ? "bg-red-950/60 text-red-300"
                        : note.treatment === "DISCOUNTED"
                          ? "bg-amber-900/40 text-amber-300"
                          : "bg-slate-800 text-slate-400"
                  }`}
                >
                  {commonalityLabel(note.treatment)}
                </span>
              </div>
              <p className="mt-2 break-words text-xs text-slate-400">
                {note.frequency !== null && note.populationSize !== null
                  ? `Observed in ${Math.round(note.frequency * 1000) / 10}% of eligible AEGIX-analyzed wallets (${note.distinctWallets ?? 0} of ${note.populationSize}).`
                  : "No population observation for this key."}
              </p>
              <p className="mt-1 break-words text-[11px] leading-relaxed text-slate-500">{commonalityWhy(note)}</p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 rounded border border-slate-800 bg-slate-950/40 p-2 text-[10px] leading-relaxed text-slate-500">
        Population statistics are based on wallets analyzed by AEGIX and do not represent the entire Solana network. Correlation evidence
        describes observable relationships — it never establishes common ownership or real-world identity.
      </p>
    </section>
  );
}

function CompareResultView({ result, onRetry }: { result: CompareResult; onRetry: () => void }) {
  const { correlation } = result;
  const score = correlation.correlationScore;
  const confidence = correlation.confidence;

  const strongFamilies = correlation.evidenceFamilies
    .filter((f) => f.strength >= 0.3)
    .sort((a, b) => b.strength - a.strength);

  return (
    <div className="mt-8 space-y-6">
      {result.cached && <p className="text-xs text-slate-500">Cached result — no new computation was performed.</p>}
      <SaveComparisonButton result={result} />

      {/* Primary result: strength and confidence are SEPARATE metrics (D5-I §29). */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Correlation Strength</p>
            <p className="mt-1 text-4xl font-bold">{score} <span className="text-lg text-slate-500">/ 100</span></p>
            <p className="mt-1 text-sm font-semibold text-amber-300">{correlation.classification.replace(/_/g, " ")}</p>
            {strengthBar(score / 100)}
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Confidence</p>
            <p className="mt-1 text-4xl font-bold">{Math.round(confidence * 100)}%</p>
            <p className="mt-1 text-xs text-slate-500">How much the available evidence supports this assessment</p>
          </div>
        </div>
        <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400">
          Correlation indicates observable linkability. It does not establish common ownership or real-world identity.
        </p>
      </section>

      {/* Why correlated / why misleading (D5-I §32-§33). */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="text-sm font-semibold">Why might these wallets be related?</h2>
          {strongFamilies.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">No strong independent evidence families observed.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs text-slate-400">
              {strongFamilies.slice(0, 3).map((f) => (
                <li key={f.family}>• {familyLabel(f.family)} — {f.summary}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="text-sm font-semibold">Why might this be misleading?</h2>
          <ul className="mt-2 space-y-1 text-xs text-slate-400">
            {(correlation.limitations.length > 0 ? correlation.limitations : result.limitations).slice(0, 4).map((l, i) => (
              <li key={i}>• {l}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* Dimension breakdown (D5-I §31). */}
      <section>
        <h2 className="text-sm font-semibold">Dimension Breakdown</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {correlation.evidenceFamilies.map((f) => (
            <FamilyCard key={f.family} family={f} />
          ))}
          {correlation.evidenceFamilies.length === 0 && <p className="text-sm text-slate-500">No overlapping evidence dimensions observed.</p>}
        </div>
      </section>

      {/* D6-I3: population commonality (why does this shared counterparty
          contribute weakly/strongly?). Mobile-friendly cards; every empirical
          percentage carries the AEGIX-population disclaimer (§30). */}
      <CommonalitySection commonality={result.commonality} />

      {/* Relationship paths (D5-I §38-§42). */}
      <section>
        <h2 className="text-sm font-semibold">Relationship Paths</h2>
        <p className="mt-1 text-xs text-slate-500">
          Showing strongest bounded relationship paths within the current analysis scope. Solid = observed, dashed = inferred.
        </p>
        <div className="mt-3 space-y-2">
          {result.relationshipPaths.length === 0 && <p className="text-sm text-slate-500">No qualifying relationship paths in the bounded graph.</p>}
          {result.relationshipPaths.map((p) => (
            <PathView key={p.id} path={p} />
          ))}
        </div>
      </section>

      {/* Cluster context (D5-I §43). */}
      <section>
        <h2 className="text-sm font-semibold">Potentially Related Wallets</h2>
        <p className="mt-1 text-xs text-slate-500">Relationship hypotheses — never ownership claims.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {result.clusters.length === 0 && <p className="text-sm text-slate-500">No qualifying relationship cluster for these wallets.</p>}
          {result.clusters.map((c) => (
            <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">Cluster</span>
                <span className="text-xs text-slate-500">confidence {Math.round(c.confidence * 100)}%</span>
              </div>
              <div className="mt-2 space-y-2">
                {c.members.map((m) => (
                  <ClusterMemberCard key={m.wallet} member={m} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Analyses + engines + data quality. */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-500">
        <p>Analyses: A {result.analyses.a?.status ?? "none"} · B {result.analyses.b?.status ?? "none"}</p>
        <p className="mt-1">Engine versions: {Object.entries(result.engineVersions).map(([k, v]) => `${k}=${v}`).join(" · ")}</p>
        <button onClick={onRetry} className="mt-3 rounded bg-slate-800 px-3 py-1.5 font-semibold text-slate-200 hover:bg-slate-700">
          Re-run comparison
        </button>
      </section>
    </div>
  );
}
