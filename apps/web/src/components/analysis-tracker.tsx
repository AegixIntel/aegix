"use client";

import { useEffect, useState } from "react";
import { getAnalysisStatus } from "@/lib/api";

const STAGE_LABELS: Record<string, string> = {
  CREATED: "Request received",
  QUEUED: "Queued",
  FETCHING: "Fetching activity",
  NORMALIZING: "Processing transactions",
  ENTITY_ANALYSIS: "Matching entities",
  RELATIONSHIP_ANALYSIS: "Analyzing relationships",
  BEHAVIOR_ANALYSIS: "Analyzing behavior",
  SCORING: "Calculating exposure",
  GRAPH_ANALYSIS: "Building attack surface",
  EXPLANATION: "Finalizing report",
  PERSISTING: "Saving report",
  READY: "Ready",
  FAILED: "Failed"
};

export default function AnalysisTracker({ analysisId, onComplete }: { analysisId: string; onComplete?: () => void }) {
  const [status, setStatus] = useState<string>("CREATED");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const result = await getAnalysisStatus(analysisId);
        if (cancelled) return;
        setStatus(result.status);
        setProgress(result.progress);
        if (result.status !== "READY" && result.status !== "FAILED") {
          timer = setTimeout(poll, 3000);
        } else {
          onComplete?.();
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    }
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [analysisId, onComplete]);

  const stageLabel = STAGE_LABELS[status] ?? status;

  return (
    <div className="mx-auto max-w-lg rounded-lg border border-ink/15 bg-paper-raised p-6">
      <div className="flex items-center justify-between">
        <p className="font-semibold">{stageLabel}</p>
        <p className="text-sm text-muted-foreground">{status}</p>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-ink/[0.06]">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.max(progress, status === "READY" ? 100 : 5)}%` }}
        />
      </div>
      {status === "READY" && (
        <p className="mt-4 text-sm text-emerald-800">Analysis complete.</p>
      )}
      {status === "FAILED" && (
        <p className="mt-4 text-sm text-red-700">Analysis failed. Please try again.</p>
      )}
    </div>
  );
}
