"use client";

import { useEffect, useState } from "react";
import { createAnalysis } from "@/lib/api";

export default function AnalyzeForm({ initialAddress = "" }: { initialAddress?: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultAddress, setResultAddress] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const trimmed = address.trim();
      await createAnalysis(trimmed);
      setResultAddress(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label htmlFor="wallet" className="text-sm text-slate-400">
          Solana wallet address
        </label>
        <input
          id="wallet"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Enter a Solana address"
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 placeholder-slate-500 outline-none focus:border-accent"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={loading || address.trim().length < 32}
          className="rounded-lg bg-accent px-4 py-3 font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {loading ? "Requesting analysis…" : "Analyze wallet"}
        </button>
      </form>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {resultAddress && (
        <div className="mt-6 rounded-lg border border-slate-700 bg-slate-900 p-4">
          <p className="text-sm text-slate-300">
            Analysis requested.{" "}
            <a href={`/analyze/${resultAddress}`} className="text-accent underline">
              Open Wallet X-Ray
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
