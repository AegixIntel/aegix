"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getSavedComparison,
  updateSavedComparison,
  deleteSavedComparison,
  type SavedComparisonDetail
} from "@/lib/api";

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export default function SavedComparisonPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [detail, setDetail] = useState<SavedComparisonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await getSavedComparison(id);
      setDetail(d);
      setLabel(d.saved.label ?? "");
      setNotes(d.saved.notes ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load saved comparison");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveMeta(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const updated = await updateSavedComparison(id, { label: label || null, notes: notes || null });
      setDetail((d) => (d ? { ...d, saved: updated } : d));
      setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  async function unsave() {
    await deleteSavedComparison(id);
    router.push("/dashboard");
  }

  const { saved, comparison, stale } = detail ?? { saved: null, comparison: null, stale: false };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a href="/dashboard" className="text-xs text-slate-500 hover:text-accent">← Dashboard</a>
          <h1 className="mt-1 text-2xl font-bold">
            {saved?.label ? `${saved.label} · ` : ""}
            <span className="font-mono">{saved ? `${shortAddress(saved.wallet_a)} vs ${shortAddress(saved.wallet_b)}` : "Saved Comparison"}</span>
          </h1>
          <p className="text-sm text-slate-400">Saved {saved ? new Date(saved.created_at).toLocaleString() : ""}</p>
        </div>
        <button
          onClick={() => void unsave()}
          className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10"
        >
          Unsave
        </button>
      </header>

      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}

      {saved && (
        <div className="mt-6 space-y-6">
          {/* Snapshot state (D6-A §10): the user must always know whether they
              see the saved historical result or current intelligence. */}
          <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-400">
            <p>
              Result:{" "}
              <span className="font-semibold text-slate-200">
                {comparison ? (stale ? "Current intelligence (rebuilt from persisted data)" : "Saved historical result") : "No persisted result yet"}
              </span>
              {saved.engine_version && <span> · engine {saved.engine_version}</span>}
              {saved.result_created_at && <span> · computed {new Date(saved.result_created_at).toLocaleString()}</span>}
            </p>
            {stale && (
              <p className="mt-1 text-amber-300">
                The underlying analysis data is no longer fresh. Run a new comparison from /compare to refresh — this page never triggers analysis automatically.
              </p>
            )}
          </section>

          {/* User-owned metadata only (D6-A §15): score/confidence/evidence
              are never editable from the client. */}
          <form onSubmit={(e) => void saveMeta(e)} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
            <h2 className="text-sm font-semibold">Label & Notes</h2>
            <label className="mt-3 block text-xs text-slate-500">
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
              />
            </label>
            <label className="mt-3 block text-xs text-slate-500">
              Notes (private)
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                rows={3}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
              />
            </label>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save metadata"}
              </button>
              {message && <span className="text-xs text-slate-400">{message}</span>}
            </div>
          </form>

          {comparison && (
            <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm">
              <h2 className="text-sm font-semibold">Correlation</h2>
              <p className="mt-2">
                Strength <span className="text-2xl font-bold">{comparison.correlation.correlationScore}</span>/100
                {" · "}Confidence <span className="font-semibold">{Math.round(comparison.correlation.confidence * 100)}%</span>
                {" · "}{comparison.correlation.classification.replace(/_/g, " ")}
              </p>
              <p className="mt-1 text-xs text-slate-500">{comparison.correlation.evidenceFamilies.map((f) => f.family).join(" + ") || "No overlapping evidence families"}</p>
              <p className="mt-2 text-xs text-slate-500">Correlation indicates observable linkability — it never establishes common ownership.</p>
              <a href={`/compare?a=${saved.wallet_a}&b=${saved.wallet_b}`} className="mt-3 inline-block text-xs text-accent underline">
                Open in Compare
              </a>
            </section>
          )}

          {!comparison && !stale && (
            <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
              No persisted comparison payload for this pair yet — run a comparison from /compare to populate it.
            </section>
          )}
        </div>
      )}
    </main>
  );
}
