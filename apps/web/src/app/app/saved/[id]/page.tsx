"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
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
    router.push("/app/dashboard");
  }

  const { saved, comparison, stale } = detail ?? { saved: null, comparison: null, stale: false };

  return (
    <div className="container-page py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/app/dashboard" className="text-xs text-muted-foreground hover:text-accent">← Dashboard</Link>
          <h1 className="mt-1 font-display text-2xl font-semibold text-marble">
            {saved?.label ? `${saved.label} · ` : ""}
            <span className="font-mono">{saved ? `${shortAddress(saved.wallet_a)} vs ${shortAddress(saved.wallet_b)}` : "Saved Comparison"}</span>
          </h1>
          <p className="text-sm text-muted-foreground">Saved {saved ? new Date(saved.created_at).toLocaleString() : ""}</p>
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
          <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4 text-xs text-muted-foreground">
            <p>
              Result:{" "}
              <span className="font-semibold text-marble/90">
                {comparison ? (stale ? "Current intelligence (rebuilt from persisted data)" : "Saved historical result") : "No persisted result yet"}
              </span>
              {saved.engine_version && <span> · engine {saved.engine_version}</span>}
              {saved.result_created_at && <span> · computed {new Date(saved.result_created_at).toLocaleString()}</span>}
            </p>
            {stale && (
              <p className="mt-1 text-amber-300">
                The underlying analysis data is no longer fresh. Run a new comparison from Compare to refresh — this page never triggers analysis automatically.
              </p>
            )}
          </section>

          {/* User-owned metadata only (D6-A §15): score/confidence/evidence
              are never editable from the client. */}
          <form onSubmit={(e) => void saveMeta(e)} className="card-surface p-5">
            <h2 className="text-sm font-semibold text-marble">Label & Notes</h2>
            <label className="mt-3 block text-xs text-muted-foreground">
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-marble outline-none focus:border-accent"
              />
            </label>
            <label className="mt-3 block text-xs text-muted-foreground">
              Notes (private)
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                rows={3}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-marble outline-none focus:border-accent"
              />
            </label>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="btn-primary px-4 py-2 text-xs"
              >
                {saving ? "Saving…" : "Save metadata"}
              </button>
              {message && <span className="text-xs text-muted-foreground">{message}</span>}
            </div>
          </form>

          {comparison && (
            <section className="card-surface p-5 text-sm">
              <h2 className="text-sm font-semibold text-marble">Correlation</h2>
              <p className="mt-2">
                Strength <span className="text-2xl font-bold text-marble">{comparison.correlation.correlationScore}</span>/100
                {" · "}Confidence <span className="font-semibold">{Math.round(comparison.correlation.confidence * 100)}%</span>
                {" · "}{comparison.correlation.classification.replace(/_/g, " ")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{comparison.correlation.evidenceFamilies.map((f) => f.family).join(" + ") || "No overlapping evidence families"}</p>
              <p className="mt-2 text-xs text-muted-foreground">Correlation indicates observable linkability — it never establishes common ownership.</p>
              <Link href={`/app/compare?a=${saved.wallet_a}&b=${saved.wallet_b}`} className="mt-3 inline-block text-xs text-accent underline">
                Open in Compare
              </Link>
            </section>
          )}

          {!comparison && !stale && (
            <section className="card-surface p-5 text-sm text-muted-foreground">
              No persisted comparison payload for this pair yet — run a comparison from Compare to populate it.
            </section>
          )}
        </div>
      )}
    </div>
  );
}
