import type { AnalysisJobRow, PathRow, ScoreRow, SignalRow } from "@aegix/database";
import type {
  AttackPathChange,
  BehaviorChange,
  Comparability,
  DataQualityChange,
  DimensionChange,
  EntityChange,
  ExposureDiff,
  RelationshipChange,
  ScoreChange,
  SignalChange,
  SignalIdentity
} from "@aegix/types";

export const DIFF_ENGINE_VERSION = "diff-v1.0.0";

/** Data-quality degradation threshold: coverage drop >= 20 points is material. */
const DATA_QUALITY_DEGRADE_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Score diff
// ---------------------------------------------------------------------------

export function scoreChange(previous: number, current: number): ScoreChange {
  const delta = current - previous;
  return {
    previous,
    current,
    delta,
    direction: delta > 0 ? "INCREASED" : delta < 0 ? "DECREASED" : "UNCHANGED"
  };
}

const DIMENSION_LABELS: Record<string, string> = {
  identityLinkability: "Identity Linkability",
  fundingExposure: "Funding Exposure",
  walletClusterExposure: "Wallet Cluster Exposure",
  behavioralFingerprint: "Behavioral Fingerprint",
  counterpartyExposure: "Counterparty Exposure",
  entityExposure: "Entity Exposure",
  transactionPatternExposure: "Transaction Pattern Exposure"
};

export function diffScores(previous: ScoreRow | null, current: ScoreRow | null): {
  overallChange: ScoreChange;
  dimensionChanges: DimensionChange[];
} {
  if (!previous || !current) {
    const currentOverall = current?.overall_score ?? 0;
    const change = scoreChange(0, currentOverall);
    const dimensions = Object.keys(DIMENSION_LABELS).map((key) => ({
      key,
      label: DIMENSION_LABELS[key] ?? key,
      change: scoreChange(0, current ? (current as unknown as Record<string, number>)[key] ?? 0 : 0)
    }));
    return { overallChange: change, dimensionChanges: dimensions };
  }
  const dimensionChanges: DimensionChange[] = Object.keys(DIMENSION_LABELS).map((key) => {
    const prevVal = (previous as unknown as Record<string, number>)[key] ?? 0;
    const currVal = (current as unknown as Record<string, number>)[key] ?? 0;
    return { key, label: DIMENSION_LABELS[key] ?? key, change: scoreChange(prevVal, currVal) };
  });
  return { overallChange: scoreChange(previous.overall_score, current.overall_score), dimensionChanges };
}

// ---------------------------------------------------------------------------
// Signal identity + diff
// ---------------------------------------------------------------------------

interface EvidenceEntry {
  key: string;
  value: string | number | boolean;
  label?: string;
}

function evidenceList(signal: SignalRow): EvidenceEntry[] {
  const raw = signal.evidence_json;
  if (Array.isArray(raw)) return raw as EvidenceEntry[];
  return [];
}

function firstEvidenceValue(signal: SignalRow, ...keys: string[]): string | null {
  for (const entry of evidenceList(signal)) {
    if (keys.includes(entry.key) && typeof entry.value === "string" && entry.value) return entry.value;
  }
  return null;
}

/**
 * Canonical signal identity, see D4-C §23: semantic keys, never the row id.
 * A signal changing confidence/severity keeps the same identity.
 */
export function signalIdentity(signal: SignalRow): SignalIdentity {
  return {
    type: signal.signal_type,
    subject: firstEvidenceValue(signal, "subject", "wallet", "address"),
    counterparty: firstEvidenceValue(signal, "counterparty", "from", "to"),
    entity: firstEvidenceValue(signal, "entity", "entityName", "protocol", "program")
  };
}

export function signalIdentityKey(identity: SignalIdentity): string {
  return [identity.type, identity.subject ?? "-", identity.counterparty ?? "-", identity.entity ?? "-"].join("|");
}

export function signalIdentityKeyForRow(signal: SignalRow): string {
  return signalIdentityKey(signalIdentity(signal));
}

export function diffSignals(previous: SignalRow[], current: SignalRow[]): {
  newSignals: SignalChange[];
  removedSignals: SignalChange[];
  changedSignals: SignalChange[];
} {
  const prevMap = new Map(previous.map((s) => [signalIdentityKeyForRow(s), s]));
  const currMap = new Map(current.map((s) => [signalIdentityKeyForRow(s), s]));

  const newSignals: SignalChange[] = [];
  const removedSignals: SignalChange[] = [];
  const changedSignals: SignalChange[] = [];

  for (const [key, curr] of currMap) {
    const prev = prevMap.get(key);
    const base = { identity: signalIdentity(curr), type: curr.signal_type };
    if (!prev) {
      newSignals.push({ ...base, previous: null, current: { severity: curr.severity, confidence: Number(curr.confidence) }, change: "NEW" });
    } else if (prev.severity !== curr.severity || Number(prev.confidence) !== Number(curr.confidence)) {
      changedSignals.push({
        ...base,
        previous: { severity: prev.severity, confidence: Number(prev.confidence) },
        current: { severity: curr.severity, confidence: Number(curr.confidence) },
        change: "CHANGED"
      });
    }
  }
  for (const [key, prev] of prevMap) {
    if (!currMap.has(key)) {
      removedSignals.push({
        identity: signalIdentity(prev),
        type: prev.signal_type,
        previous: { severity: prev.severity, confidence: Number(prev.confidence) },
        current: null,
        change: "REMOVED"
      });
    }
  }
  return { newSignals, removedSignals, changedSignals };
}

// ---------------------------------------------------------------------------
// Entity diff — derived from KNOWN_ENTITY_INTERACTION signals (entity registry
// names live in signal evidence; entity addresses in evidence "address").
// ---------------------------------------------------------------------------

export function diffEntities(previous: SignalRow[], current: SignalRow[]): EntityChange[] {
  const entitySignals = (rows: SignalRow[]) =>
    rows.filter((s) => s.signal_type === "KNOWN_ENTITY_INTERACTION");

  const buildMap = (rows: SignalRow[]) => {
    const map = new Map<string, { count: number; confidence: number; entityType: string | null }>();
    for (const s of entitySignals(rows)) {
      const name = firstEvidenceValue(s, "entity", "entityName") ?? `entity-${s.severity}`;
      const entry = map.get(name) ?? { count: 0, confidence: 0, entityType: firstEvidenceValue(s, "entityType") };
      entry.count += 1;
      entry.confidence = Math.max(entry.confidence, Number(s.confidence));
      map.set(name, entry);
    }
    return map;
  };

  const prevMap = buildMap(previous);
  const currMap = buildMap(current);
  const changes: EntityChange[] = [];

  for (const [name, curr] of currMap) {
    const prev = prevMap.get(name);
    if (!prev) {
      changes.push({
        entityName: name,
        entityType: curr.entityType,
        change: "NEW_ENTITY_EXPOSURE",
        previous: null,
        current: { count: curr.count, confidence: curr.confidence }
      });
    } else if (curr.count > prev.count) {
      changes.push({
        entityName: name,
        entityType: curr.entityType,
        change: "ENTITY_INTERACTION_INCREASED",
        previous: { count: prev.count, confidence: prev.confidence },
        current: { count: curr.count, confidence: curr.confidence }
      });
    } else if (Math.abs(curr.confidence - prev.confidence) > 0.1) {
      changes.push({
        entityName: name,
        entityType: curr.entityType,
        change: "ENTITY_CONFIDENCE_CHANGED",
        previous: { count: prev.count, confidence: prev.confidence },
        current: { count: curr.count, confidence: curr.confidence }
      });
    }
  }
  for (const [name, prev] of prevMap) {
    if (!currMap.has(name)) {
      changes.push({
        entityName: name,
        entityType: prev.entityType,
        change: "ENTITY_EXPOSURE_REMOVED",
        previous: { count: prev.count, confidence: prev.confidence },
        current: null
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Relationship diff — derived from repeated funding/counterparty signals.
// ---------------------------------------------------------------------------

export function diffRelationships(previous: SignalRow[], current: SignalRow[]): RelationshipChange[] {
  const relSignals = (rows: SignalRow[]) =>
    rows.filter((s) => s.signal_type === "REPEATED_FUNDING" || s.signal_type === "REPEATED_COUNTERPARTY");

  const buildMap = (rows: SignalRow[]) => {
    const map = new Map<string, { count: number; concentration: number }>();
    for (const s of relSignals(rows)) {
      const counterparty = firstEvidenceValue(s, "counterparty", "from", "to") ?? `cp-${s.severity}`;
      const countEntry = evidenceList(s).find((e) => e.key === "count" || e.key === "transactionCount");
      const count = typeof countEntry?.value === "number" ? countEntry.value : 1;
      const concEntry = evidenceList(s).find((e) => e.key === "concentration" || e.key === "fundingConcentration");
      const concentration = typeof concEntry?.value === "number" ? concEntry.value : 0;
      const existing = map.get(counterparty);
      if (existing) {
        existing.count += count;
        existing.concentration = Math.max(existing.concentration, concentration);
      } else {
        map.set(counterparty, { count, concentration });
      }
    }
    return map;
  };

  const prevMap = buildMap(previous);
  const currMap = buildMap(current);
  const changes: RelationshipChange[] = [];

  for (const [counterparty, curr] of currMap) {
    const prev = prevMap.get(counterparty);
    if (!prev) {
      changes.push({
        counterparty,
        relationshipType: "REPEATED_FUNDING_RELATIONSHIP_CREATED",
        change: curr.count >= 3 ? "NEW_REPEATED_COUNTERPARTY" : "NEW_FUNDING_SOURCE",
        previous: null,
        current: { transactionCount: curr.count, concentration: curr.concentration }
      });
    } else if (curr.count >= 3 && prev.count < 3) {
      changes.push({
        counterparty,
        relationshipType: "REPEATED_COUNTERPARTY",
        change: "REPEATED_FUNDING_RELATIONSHIP_CREATED",
        previous: { transactionCount: prev.count, concentration: prev.concentration },
        current: { transactionCount: curr.count, concentration: curr.concentration }
      });
    } else if (curr.concentration > 0.5 && prev.concentration <= 0.5) {
      changes.push({
        counterparty,
        relationshipType: "FUNDING_SOURCE_BECAME_DOMINANT",
        change: "FUNDING_SOURCE_BECAME_DOMINANT",
        previous: { transactionCount: prev.count, concentration: prev.concentration },
        current: { transactionCount: curr.count, concentration: curr.concentration }
      });
    } else if (curr.concentration - prev.concentration > 0.2) {
      changes.push({
        counterparty,
        relationshipType: "COUNTERPARTY_CONCENTRATION_INCREASED",
        change: "COUNTERPARTY_CONCENTRATION_INCREASED",
        previous: { transactionCount: prev.count, concentration: prev.concentration },
        current: { transactionCount: curr.count, concentration: curr.concentration }
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Behavior diff — activity timing, protocol usage, tx frequency, counterparty
// diversity, asset movement (from behavior signal evidence).
// ---------------------------------------------------------------------------

export function diffBehavior(previous: SignalRow[], current: SignalRow[]): BehaviorChange[] {
  const behaviorSignals = (rows: SignalRow[]) =>
    rows.filter((s) => s.signal_type === "NARROW_ACTIVITY_WINDOW" || s.signal_type === "SINGLE_PROTOCOL_USE");

  const summarize = (rows: SignalRow[]): { timing: number; protocol: number } => {
    let timing = 0;
    let protocol = 0;
    for (const s of behaviorSignals(rows)) {
      if (s.signal_type === "NARROW_ACTIVITY_WINDOW") timing = Math.max(timing, s.severity);
      if (s.signal_type === "SINGLE_PROTOCOL_USE") protocol = Math.max(protocol, s.severity);
    }
    return { timing, protocol };
  };

  const prev = summarize(previous);
  const curr = summarize(current);
  const changes: BehaviorChange[] = [];
  if (curr.timing - prev.timing >= 20) {
    changes.push({ feature: "activityTiming", change: "ACTIVITY_TIMING_CHANGED", previous: prev.timing, current: curr.timing });
  }
  if (curr.protocol - prev.protocol >= 20) {
    changes.push({ feature: "protocolUsage", change: "PROTOCOL_USAGE_CHANGED", previous: prev.protocol, current: curr.protocol });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Attack path diff — path identity is a hash of the ordered node labels so a
// reorder alone does not count as a change (D4-C §28).
// ---------------------------------------------------------------------------

export function pathIdentity(path: PathRow): string {
  const nodes = Array.isArray(path.nodes_json) ? path.nodes_json as Array<{ label?: string; type?: string }> : [];
  return nodes.map((n) => `${n.type ?? "?"}:${n.label ?? "?"}`).join(">");
}

export function diffAttackPaths(previous: PathRow[], current: PathRow[]): AttackPathChange[] {
  const prevMap = new Map(previous.map((p) => [pathIdentity(p), p]));
  const currMap = new Map(current.map((p) => [pathIdentity(p), p]));
  const changes: AttackPathChange[] = [];

  for (const [id, curr] of currMap) {
    const prev = prevMap.get(id);
    if (!prev) {
      changes.push({
        change: "NEW_EXPOSURE_PATH",
        pathId: id,
        previous: null,
        current: { pathScore: curr.path_score, confidence: Number(curr.confidence_score) }
      });
    } else if (curr.path_score > prev.path_score + 0.1) {
      changes.push({
        change: "STRONGER_EXPOSURE_PATH",
        pathId: id,
        previous: { pathScore: prev.path_score, confidence: Number(prev.confidence_score) },
        current: { pathScore: curr.path_score, confidence: Number(curr.confidence_score) }
      });
    } else if (Number(curr.confidence_score) > Number(prev.confidence_score) + 0.1) {
      changes.push({
        change: "PATH_CONFIDENCE_INCREASED",
        pathId: id,
        previous: { pathScore: prev.path_score, confidence: Number(prev.confidence_score) },
        current: { pathScore: curr.path_score, confidence: Number(curr.confidence_score) }
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Data quality + comparability
// ---------------------------------------------------------------------------

interface DataQualitySummary {
  score: number | null;
  semanticCoverage: number | null;
}

function dataQualityOf(job: AnalysisJobRow | null): DataQualitySummary {
  if (!job) return { score: null, semanticCoverage: null };
  const dq = (job.data_quality ?? {}) as Record<string, unknown>;
  return {
    score: typeof dq.dataQualityScore === "number" ? dq.dataQualityScore : null,
    semanticCoverage: typeof dq.semanticCoverage === "number" ? dq.semanticCoverage : null
  };
}

/**
 * Data-quality awareness, see D4-C §29: a drop in understanding must never be
 * read as "exposure disappeared". `degraded` is set when semantic coverage or
 * the quality score fell materially; `material` drives DATA_QUALITY_DEGRADED.
 */
export function assessDataQualityChange(previous: AnalysisJobRow | null, current: AnalysisJobRow | null): DataQualityChange {
  const prev = dataQualityOf(previous);
  const curr = dataQualityOf(current);
  const coverageDelta = curr.semanticCoverage !== null && prev.semanticCoverage !== null
    ? curr.semanticCoverage - prev.semanticCoverage
    : 0;
  const scoreDelta = curr.score !== null && prev.score !== null ? curr.score - prev.score : 0;
  const degraded = coverageDelta < -DATA_QUALITY_DEGRADE_THRESHOLD || scoreDelta < -DATA_QUALITY_DEGRADE_THRESHOLD;
  const material = coverageDelta < -(DATA_QUALITY_DEGRADE_THRESHOLD * 1.5) || scoreDelta < -(DATA_QUALITY_DEGRADE_THRESHOLD * 1.5);
  return {
    previous: { score: prev.score ?? 0, semanticCoverage: prev.semanticCoverage ?? 0 },
    current: { score: curr.score ?? 0, semanticCoverage: curr.semanticCoverage ?? 0 },
    degraded,
    material
  };
}

/**
 * Comparability, see D4-C §30-§32: engine/scoring version drift must not be
 * interpreted as wallet exposure change. When versions differ, score-based
 * events are suppressed downstream and confidence is discounted.
 */
export function computeComparability(previous: AnalysisJobRow | null, current: AnalysisJobRow | null, previousScore: ScoreRow | null, currentScore: ScoreRow | null): Comparability {
  const previousEngine = previous?.engine_version ?? null;
  const currentEngine = current?.engine_version ?? null;
  const previousScoring = previousScore?.scoring_version ?? null;
  const currentScoring = currentScore?.scoring_version ?? null;
  const engineVersionChanged = previousEngine !== currentEngine;
  const scoringVersionChanged = previousScoring !== currentScoring;
  const comparable = !engineVersionChanged && !scoringVersionChanged;
  return {
    comparable,
    reason: comparable
      ? null
      : engineVersionChanged && scoringVersionChanged
        ? "engine and scoring versions changed"
        : engineVersionChanged
          ? "engine version changed"
          : "scoring version changed",
    engineVersionChanged,
    scoringVersionChanged,
    previousEngineVersion: previousEngine,
    currentEngineVersion: currentEngine
  };
}

// ---------------------------------------------------------------------------
// Full diff assembly
// ---------------------------------------------------------------------------

export interface DiffInputs {
  monitorId: string;
  previousAnalysisId: string;
  currentAnalysisId: string;
  previousJob: AnalysisJobRow | null;
  currentJob: AnalysisJobRow | null;
  previousScore: ScoreRow | null;
  currentScore: ScoreRow | null;
  previousSignals: SignalRow[];
  currentSignals: SignalRow[];
  previousPaths: PathRow[];
  currentPaths: PathRow[];
}

export function buildExposureDiff(inputs: DiffInputs): ExposureDiff {
  const { previousSignals, currentSignals } = inputs;
  const { overallChange, dimensionChanges } = diffScores(inputs.previousScore, inputs.currentScore);
  const { newSignals, removedSignals, changedSignals } = diffSignals(previousSignals, currentSignals);
  const entityChanges = diffEntities(previousSignals, currentSignals);
  const relationshipChanges = diffRelationships(previousSignals, currentSignals);
  const behaviorChanges = diffBehavior(previousSignals, currentSignals);
  const attackPathChanges = diffAttackPaths(inputs.previousPaths, inputs.currentPaths);
  const dataQualityChange = assessDataQualityChange(inputs.previousJob, inputs.currentJob);
  const comparability = computeComparability(inputs.previousJob, inputs.currentJob, inputs.previousScore, inputs.currentScore);

  // Diff confidence: based on how much evidence the comparison rests on and
  // how comparable the two analyses are.
  const evidenceCount = newSignals.length + entityChanges.length + relationshipChanges.length + attackPathChanges.length;
  let confidence = 0.5 + Math.min(0.4, evidenceCount * 0.05);
  if (!comparability.comparable) confidence *= 0.5;
  if (dataQualityChange.degraded) confidence *= 0.7;
  confidence = Math.max(0.05, Math.min(0.98, confidence));

  return {
    monitorId: inputs.monitorId,
    previousAnalysisId: inputs.previousAnalysisId,
    currentAnalysisId: inputs.currentAnalysisId,
    overallChange,
    dimensionChanges,
    newSignals,
    removedSignals,
    changedSignals,
    entityChanges,
    relationshipChanges,
    behaviorChanges,
    attackPathChanges,
    dataQualityChange,
    comparability,
    confidence,
    diffVersion: DIFF_ENGINE_VERSION,
    createdAt: new Date().toISOString()
  };
}
