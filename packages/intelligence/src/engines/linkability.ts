import type { IntelligenceSignal, SignalCategory } from "@aegix/types";
import { makeSignal } from "../signals.js";

export const LINKABILITY_ENGINE_VERSION = "linkability-v1.0.0";

/**
 * Evidence classes that can converge on identity linkability. These mirror
 * the signal categories, minus IDENTITY_LINKABILITY itself — the aggregate
 * must never feed on its own output.
 */
export type LinkabilityEvidenceClass = Exclude<SignalCategory, "IDENTITY_LINKABILITY">;

/**
 * Observed evidence comes from transfers or public labels that actually
 * exist on chain. Inferred evidence is statistical similarity. The
 * distinction matches `EdgeObservationClass` in the graph layer and is the
 * reason inferred-only evidence cannot produce a linkability claim here.
 */
const OBSERVED_CLASSES: ReadonlySet<LinkabilityEvidenceClass> = new Set<LinkabilityEvidenceClass>([
  "FUNDING",
  "COUNTERPARTY",
  "ENTITY",
  "PUBLIC_ATTRIBUTION"
]);

/** Linkability is a convergence claim: one class on its own is never enough. */
const MIN_CONVERGING_CLASSES = 2;
/** Each converging class beyond the first adds this much, bounded below. */
const CONVERGENCE_BONUS_PER_CLASS = 8;
const MAX_CONVERGENCE_BONUS = 24;
/**
 * With no observed evidence the wallet may still be statistically
 * distinctive, but that is not linkability — cap it well below the
 * severity bands that read as HIGH.
 */
const INFERRED_ONLY_CEILING = 35;
const INFERRED_ONLY_DISCOUNT = 0.5;
/** Correlation is not identity: this engine never reports near-certainty. */
const MAX_CONFIDENCE = 0.9;

export interface LinkabilityContribution {
  evidenceClass: LinkabilityEvidenceClass;
  signalCount: number;
  strongestSeverity: number;
  meanConfidence: number;
  observed: boolean;
}

export interface LinkabilityAnalysisInput {
  walletAddress: string;
  /** Signals from every other engine in this analysis. */
  signals: IntelligenceSignal[];
}

export interface LinkabilityAnalysisResult {
  signals: IntelligenceSignal[];
  contributions: LinkabilityContribution[];
  /**
   * 0-100 aggregate linkability measure, reported for explanation only.
   * Scoring derives its own `identityLinkability` dimension from the same
   * underlying evidence, so this value is deliberately not fed back into
   * `scoreWallet` — that would double-count it.
   */
  identityLinkabilityExposure: number;
  /** True when at least one observed class and MIN_CONVERGING_CLASSES are present. */
  converged: boolean;
}

/**
 * Identity linkability engine — the IDENTITY_LINKABILITY signal category.
 *
 * It does not look at chain data directly. It asks whether independent
 * engines point the same way, which is the only basis on which AEGIX will
 * talk about linkability at all: the strongest single signal sets the floor,
 * convergence across classes raises it, and purely statistical evidence is
 * capped so it can never present as a near-identification.
 */
export function analyzeLinkability(input: LinkabilityAnalysisInput): LinkabilityAnalysisResult {
  const byClass = new Map<LinkabilityEvidenceClass, IntelligenceSignal[]>();
  for (const signal of input.signals) {
    if (signal.category === "IDENTITY_LINKABILITY") continue;
    const cls = signal.category as LinkabilityEvidenceClass;
    const bucket = byClass.get(cls);
    if (bucket) bucket.push(signal);
    else byClass.set(cls, [signal]);
  }

  const contributions: LinkabilityContribution[] = [];
  for (const [evidenceClass, signals] of byClass) {
    contributions.push({
      evidenceClass,
      signalCount: signals.length,
      strongestSeverity: Math.max(...signals.map((s) => s.severity)),
      meanConfidence: signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length,
      observed: OBSERVED_CLASSES.has(evidenceClass)
    });
  }
  contributions.sort(
    (a, b) => b.strongestSeverity - a.strongestSeverity || a.evidenceClass.localeCompare(b.evidenceClass)
  );

  const observed = contributions.filter((c) => c.observed);
  const converged = observed.length > 0 && contributions.length >= MIN_CONVERGING_CLASSES;

  let identityLinkabilityExposure: number;
  if (observed.length === 0) {
    const strongestInferred = contributions[0]?.strongestSeverity ?? 0;
    identityLinkabilityExposure = Math.round(
      Math.min(INFERRED_ONLY_CEILING, strongestInferred * INFERRED_ONLY_DISCOUNT)
    );
  } else {
    const floor = Math.max(...observed.map((c) => c.strongestSeverity));
    const bonus = Math.min(
      MAX_CONVERGENCE_BONUS,
      CONVERGENCE_BONUS_PER_CLASS * Math.max(0, contributions.length - 1)
    );
    identityLinkabilityExposure = Math.round(clamp(floor + bonus, 0, 100));
  }

  const signals: IntelligenceSignal[] = [];
  if (converged) {
    const classList = contributions.map((c) => c.evidenceClass).join(", ");
    const meanConfidence =
      contributions.reduce((sum, c) => sum + c.meanConfidence, 0) / contributions.length;

    signals.push(
      makeSignal(
        {
          type: "CONVERGING_LINKABILITY_EVIDENCE",
          category: "IDENTITY_LINKABILITY",
          severity: identityLinkabilityExposure,
          confidence: Math.min(MAX_CONFIDENCE, meanConfidence),
          title: `${contributions.length} independent evidence classes converge`,
          summary: `Linkability evidence appears in ${contributions.length} independent classes (${classList}), ${observed.length} of them from directly observed on-chain relationships rather than statistical similarity. Converging evidence narrows the set of plausible explanations for this wallet's activity; it does not establish who controls it.`,
          evidence: [
            { key: "converging_classes", value: contributions.length, label: "Converging classes" },
            { key: "observed_classes", value: observed.length, label: "Observed classes" },
            { key: "class_list", value: classList, label: "Classes" },
            {
              key: "strongest_observed",
              value: Math.max(...observed.map((c) => c.strongestSeverity)),
              label: "Strongest observed severity"
            },
            { key: "supporting_signals", value: input.signals.length, label: "Supporting signals" }
          ]
        },
        LINKABILITY_ENGINE_VERSION
      )
    );
  }

  return { signals, contributions, identityLinkabilityExposure, converged };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
