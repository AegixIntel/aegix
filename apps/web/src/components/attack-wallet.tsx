"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getWalletXRay, createAnalysis, getLatestAnalysis, type WalletXRay, type XRayPath } from "@/lib/api";
import AnalysisTracker from "@/components/analysis-tracker";
import { EmptyState, ErrorState } from "@/components/ui/primitives";

const IN_PROGRESS_STAGES = new Set([
  "CREATED", "QUEUED", "FETCHING", "NORMALIZING", "ENTITY_ANALYSIS",
  "RELATIONSHIP_ANALYSIS", "BEHAVIOR_ANALYSIS", "SCORING", "GRAPH_ANALYSIS",
  "EXPLANATION", "PERSISTING"
]);

function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function PathCard({ path }: { path: XRayPath }) {
  return (
    <div className="border-t border-white/10 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs text-muted-2">#{path.rank}</span>
        <span className="rounded-sm border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-marble/80">
          {path.pathType}
        </span>
        <span className="ml-auto font-mono text-xs text-muted-2">
          score {Math.round(path.pathScore * 100)} · conf {Math.round(path.confidence * 100)}%
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-sm">
        {path.nodes.map((node, i) => (
          <span key={`${node.label}-${i}`} className="flex items-center gap-2">
            {i > 0 && <span className="text-accent-bright">→</span>}
            <span
              className={
                node.type === "ENTITY"
                  ? "rounded-sm bg-accent-dim px-1.5 py-0.5 text-accent-bright"
                  : "rounded-sm border border-white/10 px-1.5 py-0.5 text-marble/90"
              }
              title={node.type}
            >
              {shortAddress(node.label)}
              {node.type === "ENTITY" && <span className="ml-1 text-[9px] uppercase">entity</span>}
            </span>
          </span>
        ))}
      </div>

      <div className="mt-4 space-y-1">
        {path.edges.map((edge, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-muted-2">{shortAddress(edge.source)}</span>
            <span className="text-accent-bright">—</span>
            <span className="font-mono uppercase tracking-wide">{edge.type}</span>
            <span className="text-accent-bright">—</span>
            <span className="font-mono text-muted-2">{shortAddress(edge.target)}</span>
          </div>
        ))}
      </div>

      {path.explanation && (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{path.explanation}</p>
      )}
    </div>
  );
}

function AttackPathList({ paths }: { paths: XRayPath[] }) {
  if (paths.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <p className="section-label">Attack Paths</p>
        <span className="font-mono text-xs text-muted-2">{paths.length} paths</span>
      </div>
      {paths.slice(0, 10).map((path) => (
        <PathCard key={path.rank} path={path} />
      ))}
    </div>
  );
}

export default function AttackWalletPage({ initialAddress = "" }: { initialAddress?: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [data, setData] = useState<WalletXRay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [trackingId, setTrackingId] = useState<string | null>(null);

  const load = useCallback(async (addr: string) => {
    setLoading(true);
    setError(null);
    setTrackingId(null);
    try {
      const xray = await getWalletXRay(addr);
      setData(xray);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load analysis";
      if (message === "NO_ANALYSIS") {
        const latest = await getLatestAnalysis(addr).catch(() => null);
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
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = address.trim();
    if (trimmed.length < 32) return;
    setError(null);
    setData(null);
    setLoading(true);
    try {
      await createAnalysis(trimmed);
      void load(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis request failed");
      setLoading(false);
    }
  }

  const handleTrackerComplete = useCallback(() => {
    void load(address.trim());
  }, [load, address]);

  // Auto-load attack paths when an address is passed via URL (?address=).
  useEffect(() => {
    if (initialAddress && initialAddress.length >= 32) {
      void load(initialAddress.trim());
    }
  }, [initialAddress, load]);

  return (
    <div className="container-page py-10">
      <div className="max-w-2xl">
        <p className="section-label-accent">Attack My Wallet</p>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight text-marble md:text-4xl">
          Follow observable paths through your activity.
        </h1>
        <p className="mt-3 text-muted-foreground">
          Simulated paths an observer could follow through public on-chain data. Dashed = inferred, solid =
          observed. This is not a real-world identification claim.
        </p>
      </div>

      <form onSubmit={(e) => void submit(e)} className="mt-8 flex flex-col gap-3 sm:flex-row">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Solana wallet address"
          className="flex-1 rounded-md border border-white/10 bg-white/[0.02] px-4 py-2.5 font-mono text-sm text-marble outline-none focus:border-accent"
          spellCheck={false}
        />
        <button type="submit" disabled={loading || address.trim().length < 32} className="btn-primary whitespace-nowrap">
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </form>

      {trackingId && (
        <div className="mx-auto mt-10 max-w-lg">
          <p className="mb-4 text-sm text-muted-foreground">
            AEGIX is fetching and analyzing this wallet&apos;s public activity. This is the real pipeline.
          </p>
          <AnalysisTracker analysisId={trackingId} onComplete={handleTrackerComplete} />
        </div>
      )}

      {error === "NO_ANALYSIS" ? (
        <div className="mx-auto mt-12 max-w-md">
          <EmptyState
            title="No analysis yet"
            body="This wallet has not been analyzed. Submit it above to generate an attack-path report."
          />
        </div>
      ) : error ? (
        <div className="mx-auto mt-12 max-w-md">
          <ErrorState title="Analysis failed" message={error} />
        </div>
      ) : null}

      {data && !loading && (
        <div className="mt-12">
          {data.attackPaths.length > 0 ? (
            <AttackPathList paths={data.attackPaths} />
          ) : (
            <EmptyState
              title="No attack paths"
              body="No qualifying observable relationship paths were found in the bounded graph for this wallet. Enter another wallet to compare."
            />
          )}

          <div className="mt-10 border-t border-white/10 pt-6 text-sm text-muted-foreground">
            <ul className="space-y-1">
              <li>• Observed edges are direct, verifiable relationships.</li>
              <li>• Inferred edges are correlation hypotheses, never ownership claims.</li>
              <li>• The graph is bounded by backend limits.</li>
            </ul>
            <div className="mt-4">
              <Link href={`/app/analyze/${data.wallet.address}`} className="text-sm text-muted-foreground hover:text-marble">
                Open full Wallet X-Ray →
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
