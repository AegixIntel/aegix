import type { IntelligenceSignal, SignalCategory } from "@aegix/types";
import { MIN_TRANSFERS_FOR_DISTRIBUTION } from "@aegix/intelligence";
import {
  ABSENCE_SIGNAL_TYPES,
  AGGREGATE_SIGNAL_TYPES,
  SPARSE_SENSITIVE_CATEGORIES,
  containsUnsafeClaim,
  neutralDescription
} from "./rules.js";
import {
  CONTEXT_ENGINE_VERSION,
  dimensionId,
  indicatorId,
  signalEvidenceId,
  type ActivitySufficiency,
  type ContextCoverage,
  type ContextDimension,
  type ContextIndicator,
  type ContextSupportingEvidence,
  type KnownRiskCheck,
  type LinkabilityAssessment,
  type SuppressedIndicator,
  type WalletContextProfile
} from "./types.js";

/**
 * Fewest parsed transactions before statistical categories are reported.
 * Deliberately the same threshold the transaction pattern engine uses to
 * decide a sample has a distribution at all.
 */
export const MIN_TRANSACTIONS_FOR_CONTEXT = MIN_TRANSFERS_FOR_DISTRIBUTION;

export interface WalletContextInput {
  walletAddress: string;
  analysisId: string;
  pipelineVersion: string | null;
  scoringVersion: string | null;
  /** Signals persisted by this analysis, in any order. */
  signals: IntelligenceSignal[];
  /** Score dimensions as the caller already labels them. */
  dimensions: Array<{ key: string; label: string; score: number }>;
  coverage: ContextCoverage;
  supportingEvidence?: ContextSupportingEvidence[];
}

const KNOWN_RISK: KnownRiskCheck = {
  dataset: "NOT_AVAILABLE",
  match: "NOT_CHECKED",
  note:
    "AEGIX holds no curated malicious-address dataset, so no known-risk lookup was performed. This is not a statement that the wallet is free of such associations."
};

/**
 * Wallet Context assembler.
 *
 * It runs no analysis of its own. Everything it reports was produced by the
 * deterministic engines during the analysis it is given, and its whole job is
 * deciding what may honestly be shown: which findings stand on their own,
 * which would be double counted, and which the sample is too small to
 * support. What it withholds is reported alongside what it keeps.
 */
export function buildWalletContext(input: WalletContextInput): WalletContextProfile {
  const sufficiency: ActivitySufficiency =
    input.coverage.transactionsParsed >= MIN_TRANSACTIONS_FOR_CONTEXT
      ? "SUFFICIENT"
      : "INSUFFICIENT_ACTIVITY";

  const indicators: ContextIndicator[] = [];
  const suppressed: SuppressedIndicator[] = [];
  const aggregates: IntelligenceSignal[] = [];

  const uniqueSignals = [...input.signals].sort((a, b) =>
    b.severity - a.severity || b.confidence - a.confidence ||
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  ).filter((signal, index, all) => all.findIndex((s) => s.type === signal.type) === index);
  for (const signal of uniqueSignals) {
    if (ABSENCE_SIGNAL_TYPES.has(signal.type)) {
      suppressed.push(suppress(signal, "ABSENCE_NOT_EVIDENCE"));
      continue;
    }
    if (AGGREGATE_SIGNAL_TYPES.has(signal.type)) {
      aggregates.push(signal);
      suppressed.push(suppress(signal, "AGGREGATE_OF_LISTED_EVIDENCE"));
      continue;
    }
    if (sufficiency === "INSUFFICIENT_ACTIVITY" && SPARSE_SENSITIVE_CATEGORIES.has(signal.category)) {
      suppressed.push(suppress(signal, "INSUFFICIENT_ACTIVITY"));
      continue;
    }
    indicators.push(toIndicator(signal));
  }

  indicators.sort(
    (a, b) =>
      b.severity - a.severity || b.confidence - a.confidence || a.signalType.localeCompare(b.signalType)
  );
  suppressed.sort((a, b) => a.signalType.localeCompare(b.signalType));

  return {
    wallet: input.walletAddress,
    analysisId: input.analysisId,
    sufficiency,
    indicators,
    suppressed,
    linkability: assessLinkability(aggregates, indicators),
    knownRisk: KNOWN_RISK,
    dimensions: input.dimensions.map(
      (d): ContextDimension => ({ id: dimensionId(d.key), key: d.key, label: d.label, score: d.score })
    ),
    coverage: input.coverage,
    limitations: buildLimitations(sufficiency, suppressed, input.coverage),
    supportingEvidence: [...(input.supportingEvidence ?? [])]
      .filter((e) => sufficiency === "SUFFICIENT" || e.category !== "CORRELATION")
      .sort((a, b) => a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b)))
      .filter((e, index, all) => all.findIndex((other) => other.id === e.id) === index)
      .slice(0, 30).map((e) => ({ ...e,
        title: containsUnsafeClaim(e.title) ? e.category : e.title,
        description: containsUnsafeClaim(e.description) ? neutralDescription(e.category, e.sourceEngine) : e.description })),
    engineVersions: {
      context: CONTEXT_ENGINE_VERSION,
      pipeline: input.pipelineVersion,
      scoring: input.scoringVersion
    }
  };
}

function toIndicator(signal: IntelligenceSignal): ContextIndicator {
  const sourceEngine = engineNameFromVersion(signal.engineVersion);
  const summary = signal.summary ?? "";
  const description =
    summary.length > 0 && !containsUnsafeClaim(summary)
      ? summary
      : neutralDescription(signal.type, sourceEngine);

  return {
    id: indicatorId(signal.type),
    signalType: signal.type,
    category: signal.category,
    severity: signal.severity,
    confidence: signal.confidence,
    title: containsUnsafeClaim(signal.title) ? signal.type : signal.title,
    description,
    sourceEngine,
    engineVersion: signal.engineVersion,
    evidence: signal.evidence,
    evidenceRefs: [signalEvidenceId(signal.type)]
  };
}

function suppress(signal: IntelligenceSignal, reason: SuppressedIndicator["reason"]): SuppressedIndicator {
  return {
    id: indicatorId(signal.type),
    signalType: signal.type,
    category: signal.category,
    reason
  };
}

/**
 * The aggregate is reported once, as a view over the indicators that remain
 * listed — never as an additional finding. `contributingCategories` names
 * the categories it was derived from so a reader can see the overlap rather
 * than mistake it for corroboration.
 */
function assessLinkability(
  aggregates: IntelligenceSignal[],
  indicators: ContextIndicator[]
): LinkabilityAssessment {
  const aggregate = aggregates[0];
  if (!aggregate) {
    return {
      converged: false,
      contributingCategories: [],
      severity: null,
      confidence: null,
      note:
        "No convergence across independent evidence classes was observed within the analysed history."
    };
  }

  const contributing = [...new Set(indicators.map((i) => i.category))]
    .filter((category): category is SignalCategory => category !== "IDENTITY_LINKABILITY")
    .sort();

  return {
    converged: true,
    contributingCategories: contributing,
    severity: aggregate.severity,
    confidence: aggregate.confidence,
    note:
      "Derived from the listed indicators rather than from separate observations, so it is reported once and is not counted again among them."
  };
}

function buildLimitations(
  sufficiency: ActivitySufficiency,
  suppressed: SuppressedIndicator[],
  coverage: ContextCoverage
): string[] {
  const limitations: string[] = [KNOWN_RISK.note,
    "Correlation does not prove ownership or identity. Missing evidence is not evidence of safety."
  ];

  if (sufficiency === "INSUFFICIENT_ACTIVITY") {
    limitations.push(
      `Fewer than ${MIN_TRANSACTIONS_FOR_CONTEXT} parsed transactions were available, so behavioural and transaction-pattern measures were withheld rather than computed from a sample too small to support them.`
    );
  }
  if (suppressed.some((s) => s.reason === "ABSENCE_NOT_EVIDENCE")) {
    limitations.push(
      "One or more engines reported an absence of observations. Absence within a bounded history is not evidence about the wallet and was not presented as a finding."
    );
  }
  if (coverage.historyStart && coverage.historyEnd) {
    limitations.push(
      `Findings describe analysed history from ${coverage.historyStart} to ${coverage.historyEnd} only, not the wallet's lifetime.`
    );
  }
  if (coverage.grade && coverage.grade !== "HIGH") {
    limitations.push(
      `Dataset quality for this analysis graded ${coverage.grade}; confidence values already account for it, but coverage gaps remain possible.`
    );
  }
  return limitations;
}

/** `funding-v1.0.0` names the funding engine. */
function engineNameFromVersion(engineVersion: string): string {
  const marker = engineVersion.lastIndexOf("-v");
  return marker > 0 ? engineVersion.slice(0, marker) : engineVersion || "unknown";
}
