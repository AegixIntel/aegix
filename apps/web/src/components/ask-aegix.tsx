"use client";

import { useState } from "react";
import { AskAegixError, askAegix, type AskResponse } from "@/lib/api";

/**
 * Ask AEGIX.
 *
 * The panel shows what the model was allowed to see and what was removed from
 * what it returned. A summary alone would hide both.
 */
export default function AskAegix({ wallet }: { wallet: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 3 || loading) return;

    setLoading(true);
    setUnavailable(null);
    try {
      setAnswer(await askAegix(wallet, trimmed));
    } catch (err) {
      setAnswer(null);
      if (err instanceof AskAegixError) {
        setUnavailable(
          err.detail.reason === "MISSING_CREDENTIAL"
            ? "Ask AEGIX is not configured in this environment. The analysis above is unaffected."
            : `${err.detail.message}. The analysis above is unaffected.`
        );
      } else {
        setUnavailable("Ask AEGIX is unavailable. The analysis above is unaffected.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Ask AEGIX</h2>
      <p className="mt-2 text-xs text-slate-500">
        Explains the evidence above. It cannot compute intelligence, reach the chain, or see anything the
        analysis did not already produce. Statements that cite evidence AEGIX never issued are removed before
        they reach this panel.
      </p>

      <form className="mt-4 flex flex-wrap gap-2" onSubmit={submit}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What does the funding evidence show?"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-100"
        />
        <button type="submit" className="btn-secondary px-4 py-2 text-sm" disabled={loading}>
          {loading ? "Asking…" : "Ask"}
        </button>
      </form>

      {unavailable ? (
        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {unavailable}
        </p>
      ) : null}

      {answer ? (
        <div className="mt-5 space-y-4">
          <p className="text-sm text-slate-200">{answer.answer.summary}</p>

          {answer.answer.findings.length > 0 ? (
            <ul className="space-y-2">
              {answer.answer.findings.map((f) => (
                <li key={f.statement} className="rounded-lg border border-white/5 bg-black/20 px-4 py-3">
                  <p className="text-sm text-slate-200">{f.statement}</p>
                  <p className="mt-2 font-mono text-[11px] text-slate-500">{f.evidenceIds.join("  ")}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">
              No statement survived citation checking, so nothing is shown rather than something unsupported.
            </p>
          )}

          {answer.answer.limitations.length > 0 ? (
            <ul className="space-y-1 text-xs text-slate-500">
              {answer.answer.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}

          <p className="border-t border-white/5 pt-3 text-[11px] text-slate-600">
            {answer.model} · {answer.evidenceOffered.length} evidence items offered
            {answer.contextTruncated ? ` · ${answer.contextDropped} omitted for length` : ""}
            {answer.citationsDropped > 0 ? ` · ${answer.citationsDropped} invalid citation(s) removed` : ""}
            {answer.findingsDropped > 0 ? ` · ${answer.findingsDropped} unsupported statement(s) removed` : ""}
          </p>
        </div>
      ) : null}
    </section>
  );
}
