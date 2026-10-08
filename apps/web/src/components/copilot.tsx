"use client";

import React, { useRef, useState } from "react";
import { AskAegixError, askCopilot, type CopilotResponse } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";

/**
 * AI Intelligence Copilot (D16).
 *
 * One question over what AEGIX has on record. Like Ask AEGIX, the panel shows
 * what the model was allowed to see and what was removed from what it
 * returned; each statement names the evidence it rests on.
 */

const SOURCES: Array<[keyof CopilotResponse["sources"], string]> = [
  ["signals", "stored signals and anomalies"], ["discoveries", "discoveries"], ["narratives", "news coverage"],
  ["crossMarket", "cross-market view"], ["wallet", "the wallet's analysis"]
];
const EXAMPLES = ["What changed in the last day?", "Which news topics are accelerating?", "Did signals of different market classes coincide?"];

export default function Copilot() {
  const [question, setQuestion] = useState("");
  const [wallet, setWallet] = useState("");
  const [answer, setAnswer] = useState<CopilotResponse | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { requireAuth } = useRequireAuth();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 3 || loading) return;
    // Counted before the session check, so an answer to an earlier press cannot land on this one.
    const current = ++generation.current;
    setLoading(true);
    setUnavailable(null);
    try {
      if (!(await requireAuth())) return;
      const result = await askCopilot(trimmed, wallet.trim() || undefined);
      if (current !== generation.current) return;
      setAnswer(result);
    } catch (err) {
      if (current !== generation.current) return;
      setAnswer(null);
      const detail = err instanceof AskAegixError ? err.detail : null;
      setUnavailable(
        detail?.code === "FEATURE_DISABLED" ? "The copilot is not switched on in this deployment."
          : detail?.reason === "MISSING_CREDENTIAL" ? "No AI provider is configured in this environment. The pages the copilot reads are unaffected."
            : detail?.code === "QUOTA_EXCEEDED" ? "Today's question limit is reached. It is shared with Ask AEGIX and resets at midnight UTC."
              : `${detail?.message ?? "The copilot is unavailable"}. The pages the copilot reads are unaffected.`
      );
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  const labels = new Map(answer?.evidence.map((item) => [item.id, item.label]) ?? []);
  return <main className="mx-auto max-w-5xl px-4 py-8">
    <h1 className="font-display text-2xl font-semibold text-ink">AI Intelligence Copilot</h1>
    <p className="mt-2 text-sm text-muted-foreground">Ask about what AEGIX has on record: stored signals, anomalies, discoveries, news coverage and the cross-market view. It explains that record and decides nothing in it. It cannot reach the chain or a market, and a statement that cites evidence AEGIX never issued is removed before it reaches this page.</p>

    <form className="mt-6 space-y-3" onSubmit={submit}>
      <div className="flex flex-wrap gap-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What changed in the last day?" maxLength={500} aria-label="Question"
          className="min-w-0 flex-1 rounded-lg border border-ink/10 bg-ink/[0.03] px-3 py-2 text-sm text-ink" />
        <button type="submit" className="btn-primary px-4 py-2 text-sm" disabled={loading}>{loading ? "Asking…" : "Ask"}</button>
      </div>
      <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Optional: a Solana wallet you have analysed, to include its evidence" maxLength={44} aria-label="Wallet address (optional)"
        className="w-full rounded-lg border border-ink/10 bg-ink/[0.03] px-3 py-2 font-mono text-xs text-ink" />
      <p className="flex flex-wrap gap-2 text-xs">{EXAMPLES.map((example) =>
        <button key={example} type="button" className="rounded border border-ink/10 px-3 py-1 text-muted-foreground hover:border-ink/30" onClick={() => setQuestion(example)}>{example}</button>)}</p>
    </form>

    {unavailable ? <p role="alert" className="mt-6 rounded-lg border border-amber-600/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800">{unavailable}</p> : null}

    {answer ? <section className="mt-8 space-y-4">
      <p className="text-sm text-ink">{answer.answer.summary}</p>
      {answer.answer.findings.length > 0
        ? <ul className="space-y-2">{answer.answer.findings.map((finding) => <li key={finding.statement} className="rounded-lg border border-ink/10 px-4 py-3">
          <p className="text-sm text-ink">{finding.statement}</p>
          <ul className="mt-2 text-xs text-muted-2">{finding.evidenceIds.map((id) => <li key={id}><span className="font-mono">{id}</span>{labels.has(id) ? ` — ${labels.get(id)}` : ""}</li>)}</ul>
        </li>)}</ul>
        : <p className="text-sm text-muted-foreground">No statement survived citation checking, so nothing is shown rather than something unsupported.</p>}
      <ul className="space-y-1 text-xs text-muted-2">{answer.answer.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
      <p className="border-t border-ink/10 pt-3 text-[11px] text-muted-2">
        Read: {SOURCES.filter(([key]) => answer.sources[key]).map(([, label]) => label).join(", ") || "nothing — no product the copilot reads is switched on"}
        {SOURCES.some(([key]) => !answer.sources[key] && key !== "wallet") ? ` · not read: ${SOURCES.filter(([key]) => !answer.sources[key] && key !== "wallet").map(([, label]) => label).join(", ")}` : ""}
      </p>
      <p className="text-[11px] text-muted-2">
        {answer.model} · {answer.evidenceOffered.length} evidence items offered
        {answer.contextTruncated ? ` · ${answer.contextDropped} omitted for length` : ""}
        {answer.citationsDropped > 0 ? ` · ${answer.citationsDropped} invalid citation(s) removed` : ""}
        {answer.findingsDropped > 0 ? ` · ${answer.findingsDropped} unsupported statement(s) removed` : ""}
        {` · ${answer.engineVersion}`}
      </p>
    </section> : null}
  </main>;
}
