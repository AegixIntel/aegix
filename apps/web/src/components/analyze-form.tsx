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
    <div>
      <form onSubmit={onSubmit} className="analysis-command-panel relative overflow-hidden border border-white/10 bg-black/40">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-2">New analysis request</span>
          <span className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-2">
            <span className="h-1 w-1 bg-accent-bright" aria-hidden="true" />
            Read only
          </span>
        </div>

        <div className="p-5 md:p-7">
          <label htmlFor="wallet" className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Solana wallet address
          </label>
          <div className="analysis-input mt-3 flex flex-col border border-white/15 bg-ink-deep/80 sm:flex-row sm:items-stretch">
            <div className="flex min-w-0 flex-1 items-center">
              <span className="pl-4 font-mono text-sm text-accent-bright" aria-hidden="true">›</span>
              <input
                id="wallet"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Enter a Solana address"
                className="min-w-0 flex-1 bg-transparent px-3 py-4 font-mono text-sm text-marble outline-none placeholder:text-muted-2"
                spellCheck={false}
                autoComplete="off"
                aria-describedby="wallet-hint"
              />
            </div>
            <button
              type="submit"
              disabled={loading || address.trim().length < 32}
              className="btn-primary h-14 min-w-48 whitespace-nowrap"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 animate-spin border border-black/30 border-t-black" aria-hidden="true" />
                  Requesting…
                </span>
              ) : (
                <>Analyze wallet <span className="btn-arrow" aria-hidden="true">→</span></>
              )}
            </button>
          </div>
          <div id="wallet-hint" className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-2">
            <span>Base58 · 32–44 characters</span>
            <span>No signature · No transaction</span>
          </div>
        </div>
      </form>

      {error && (
        <div role="alert" className="mt-4 border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-wider text-red-400">Request failed</span>
          {error}
        </div>
      )}

      {accountInfo && (
        <div className="mt-5 border border-white/10 bg-black/40 p-5 text-left">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-2">Account information</p>
          <p className="mt-3 font-display text-lg font-semibold capitalize text-marble">
            {accountInfo.accountType.replaceAll("_", " ")}
          </p>
          {accountInfo.protocol && (
            <p className="mt-2 text-sm text-muted-foreground">
              Protocol: <span className="font-semibold text-accent-bright">{accountInfo.protocol}</span>
            </p>
          )}
          {accountInfo.verificationStatus && (
            <p className="mt-1 text-sm text-muted-foreground">
              Verification: {accountInfo.verificationStatus}
            </p>
          )}
          <p className="mt-4 border-t border-white/10 pt-4 text-sm text-muted-foreground">
            This address is not analyzed as a personal wallet.
          </p>
        </div>
      )}

    </div>
  );
}
