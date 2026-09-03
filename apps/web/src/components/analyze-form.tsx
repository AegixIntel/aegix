"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAnalysis, getAccountClassification } from "@/lib/api";

interface AccountInfoState {
  accountType: string;
  protocol: string | null;
  verificationStatus: string | null;
}

export default function AnalyzeForm({ initialAddress = "" }: { initialAddress?: string }) {
  const router = useRouter();
  const [address, setAddress] = useState(initialAddress);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountInfo, setAccountInfo] = useState<AccountInfoState | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAccountInfo(null);
    setLoading(true);
    try {
      const trimmed = address.trim();
      try {
        await createAnalysis(trimmed);
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        // The API returns structured errors; the client surfaces friendly text.
        if (message.includes("ACCOUNT_NOT_ANALYZABLE") || message.includes("not analyzed as a personal wallet")) {
          const classification = await getAccountClassification(trimmed).catch(() => null);
          setAccountInfo({
            accountType: classification?.accountType ?? "unknown account",
            protocol: classification?.protocol ?? null,
            verificationStatus: classification?.verificationStatus ?? null
          });
          return;
        }
        if (message.includes("ANALYSIS_QUOTA_EXCEEDED") || message.includes("Daily analysis limit")) {
          setError("Daily analysis limit reached. Try again after the window resets (midnight UTC).");
          return;
        }
        if (message.includes("SERVICE_BUSY")) {
          setError("AEGIX is busy right now. Cached reports still work — try again shortly.");
          return;
        }
        throw err;
      }
      // Navigate to the wallet X-Ray route, which renders the live analysis
      // tracker (real backend stages) and then the full report.
      router.push(`/app/analyze/${trimmed}`);
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

      {accountInfo && (
        <div className="mt-6 rounded-lg border border-slate-700 bg-slate-900 p-5 text-left">
          <p className="text-xs uppercase tracking-widest text-slate-500">Account Information</p>
          <p className="mt-2 font-semibold text-slate-100">
            {accountInfo.accountType.replaceAll("_", " ")}
          </p>
          {accountInfo.protocol && (
            <p className="mt-1 text-sm text-slate-300">
              Protocol: <span className="font-semibold text-accent">{accountInfo.protocol}</span>
            </p>
          )}
          {accountInfo.verificationStatus && (
            <p className="mt-1 text-sm text-slate-400">
              Verification: {accountInfo.verificationStatus}
            </p>
          )}
          <p className="mt-3 text-sm text-slate-400">
            This address is not analyzed as a personal wallet.
          </p>
        </div>
      )}

    </div>
  );
}
