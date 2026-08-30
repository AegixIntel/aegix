import type { Evidence, IntelligenceSignal, SignalCategory } from "@aegix/types";

export interface SignalSeed {
  type: string;
  category: SignalCategory;
  severity: number;
  confidence: number;
  title: string;
  summary: string;
  evidence: Evidence[];
}

export function makeSignal(seed: SignalSeed, engineVersion: string): IntelligenceSignal {
  return {
    ...seed,
    severity: clamp(seed.severity, 0, 100),
    confidence: clamp(seed.confidence, 0, 1),
    engineVersion
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Sorts signals by severity descending, returning the top N. */
export function topSignals(signals: IntelligenceSignal[], n: number): IntelligenceSignal[] {
  return [...signals].sort((a, b) => b.severity - a.severity).slice(0, n);
}

export const INTELLIGENCE_ENGINE_VERSION = "intelligence-v1.0.0";
