/**
 * AEGIX Rewind — point-in-time replay, see docs/milestone-d14-rewind-discovery.md.
 *
 * A replay is a read of what was stored, never a recomputation. Each capture
 * carries the signals an engine produced at the time it ran, with the engine
 * version it ran as. Rewind arranges those captures on a timeline and refuses
 * to look past the lock.
 *
 * It audits observability. It does not claim the event was predictable: a
 * signal that was visible is not a signal anyone would have acted on.
 */

export const REWIND_ENGINE_VERSION = "rewind-v1.0.0";

/** Distinct signal types in one capture that count as a convergence. */
export const CONVERGENCE_MIN_SIGNAL_TYPES = 3;

export const REWIND_MIN_LOOKBACK_HOURS = 1;
export const REWIND_MAX_LOOKBACK_HOURS = 720;
export const REWIND_DEFAULT_LOOKBACK_HOURS = 72;

/** Checkpoints as fractions of the lookback: 72h → T−72, −48, −24, −8, −2. */
const CHECKPOINT_FRACTIONS = [1, 2 / 3, 1 / 3, 1 / 9, 1 / 36] as const;

export interface CapturedSignal {
  type: string;
  severity: number;
  confidence: number;
  title: string;
  summary: string;
  evidence: Array<{ key: string; value: string | number | boolean; label: string }>;
  engineVersion: string;
}

export interface CaptureRecord {
  id: string;
  /** When AEGIX stored the capture. This is the only time a replay orders by. */
  observedAt: string;
  engineVersion: string;
  qualityGrade: string;
  providerStatus: string;
  signals: CapturedSignal[];
}

/**
 * A Discovery ID that already existed. `detectedAt` is the database's stamp on
 * the discovery, and `status` its latest event stored before the lock: a
 * confirmation that came after the event is not shown.
 */
export interface KnownDiscovery {
  id: string;
  detectedAt: string;
  status: string;
  title: string;
  seriesA: string;
  seriesB: string;
  lagHours: number;
  direction: string;
  engineVersion: string;
}

/** A stored capture of something other than the subject: a news topic or a fund. */
export interface ContextCapture extends CaptureRecord {
  /** NARRATIVE or SECTOR. */
  domain: string;
  subject: string;
  /** What the subject is, in words. */
  label: string;
}

/** One signal type of one context subject, across the captures that held it in the window. */
export interface ContextObservation {
  domain: string;
  subject: string;
  label: string;
  signalType: string;
  /** Title and summary as the earliest capture stored them. */
  title: string;
  summary: string;
  firstObservedAt: string;
  lastObservedAt: string;
  captures: number;
  /** From the earliest capture to the event. */
  leadSeconds: number;
  engineVersion: string;
}

export interface ReplayInput {
  subject: string;
  /** The moment being audited ("the move"). Nothing at or after it is admitted. */
  eventTime: string;
  lookbackHours: number;
  captures: CaptureRecord[];
  /** Captures of news topics and funds that held a signal. Admitted under the same window and lock. */
  context?: ContextCapture[];
  /** Discoveries involving the subject's series. Only those stamped before the lock are admitted. */
  discoveries?: KnownDiscovery[];
  /** Server time of the request; an event in the future cannot be rewound. */
  requestedAt: string;
}

export type ReplayVerdict = "CONVERGENCE_OBSERVED" | "SIGNALS_OBSERVED" | "NOTHING_OBSERVED" | "NO_COVERAGE";

export interface ReplayCheckpoint {
  label: string;
  at: string;
  /** Captures stored between the window start and this checkpoint. */
  capturesSoFar: number;
  /** Distinct signal types stored by this checkpoint, in first-seen order. */
  signalTypesSoFar: string[];
  /** Signals in the most recent capture at or before this checkpoint. */
  latestCapture: { observedAt: string; signalTypes: string[] } | null;
}

export interface ReplayResult {
  subject: string;
  eventTime: string;
  lockedAt: string;
  windowStart: string;
  lookbackHours: number;
  verdict: ReplayVerdict;
  /** Plain answer to "Could AEGIX have seen it?", bounded by what was stored. */
  answer: string;
  checkpoints: ReplayCheckpoint[];
  convergence: { observedAt: string; leadSeconds: number; signalTypes: string[]; captureId: string } | null;
  firstSignal: { observedAt: string; leadSeconds: number; type: string; captureId: string } | null;
  coverage: {
    captures: number;
    firstCaptureAt: string | null;
    lastCaptureAt: string | null;
    largestGapSeconds: number | null;
    /** Captures handed in but refused because they fell outside the lock. */
    excludedByLock: number;
  };
  /** Timeline of every admitted capture, oldest first. */
  timeline: CaptureRecord[];
  /**
   * What news coverage and the funds were doing in the window, as stored:
   * one entry per signal type per topic or fund, earliest first. It is the
   * surroundings of the subject, not evidence about it, and does not enter
   * the verdict.
   */
  context: ContextObservation[];
  /**
   * Discoveries involving this subject that were already stamped before the
   * event, oldest first. Not limited to the window: a relationship found
   * earlier was still on record. They do not enter the verdict.
   */
  discoveries: Array<KnownDiscovery & { leadSeconds: number }>;
  engineVersions: string[];
  rewindEngineVersion: string;
  limitations: string[];
}

export class RewindError extends Error {
  readonly code: "INVALID_EVENT_TIME" | "EVENT_IN_FUTURE" | "INVALID_LOOKBACK";
  constructor(code: RewindError["code"], message: string) {
    super(message);
    this.name = "RewindError";
    this.code = code;
  }
}

function checkpointLabel(hours: number): string {
  const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return `T−${rounded}h`;
}

export function replayWindow(eventTime: string, lookbackHours: number, requestedAt: string): { start: Date; lock: Date } {
  const lock = new Date(eventTime);
  if (Number.isNaN(lock.getTime())) throw new RewindError("INVALID_EVENT_TIME", "eventTime is not a valid timestamp");
  if (lock.getTime() > new Date(requestedAt).getTime()) throw new RewindError("EVENT_IN_FUTURE", "eventTime is in the future");
  if (!Number.isFinite(lookbackHours) || lookbackHours < REWIND_MIN_LOOKBACK_HOURS || lookbackHours > REWIND_MAX_LOOKBACK_HOURS) {
    throw new RewindError("INVALID_LOOKBACK", `lookbackHours must be between ${REWIND_MIN_LOOKBACK_HOURS} and ${REWIND_MAX_LOOKBACK_HOURS}`);
  }
  return { start: new Date(lock.getTime() - lookbackHours * 3_600_000), lock };
}

export function buildReplay(input: ReplayInput): ReplayResult {
  const { start, lock } = replayWindow(input.eventTime, input.lookbackHours, input.requestedAt);
  const startMs = start.getTime();
  const lockMs = lock.getTime();

  // The lock. The caller is expected to have filtered already; this is the
  // second, independent check, so a loader bug cannot leak hindsight.
  const admitted = input.captures
    .filter((c) => {
      const t = Date.parse(c.observedAt);
      return Number.isFinite(t) && t >= startMs && t < lockMs;
    })
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id));
  const excludedByLock = input.captures.length - admitted.length;

  // The same window and lock, for context captures.
  const observed = new Map<string, ContextObservation>();
  const contextCaptures = (input.context ?? [])
    .filter((c) => { const t = Date.parse(c.observedAt); return Number.isFinite(t) && t >= startMs && t < lockMs; })
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id));
  for (const capture of contextCaptures) {
    for (const s of capture.signals) {
      const key = `${capture.domain}|${capture.subject}|${s.type}`;
      const existing = observed.get(key);
      if (existing) { existing.lastObservedAt = capture.observedAt; existing.captures += 1; continue; }
      observed.set(key, {
        domain: capture.domain, subject: capture.subject, label: capture.label, signalType: s.type, title: s.title, summary: s.summary,
        firstObservedAt: capture.observedAt, lastObservedAt: capture.observedAt, captures: 1,
        leadSeconds: Math.round((lockMs - Date.parse(capture.observedAt)) / 1000), engineVersion: s.engineVersion
      });
    }
  }
  const context = [...observed.values()];

  // The same lock, for discoveries: the stamp must be strictly before the event.
  const discoveries = (input.discoveries ?? [])
    .filter((d) => Date.parse(d.detectedAt) < lockMs)
    .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt) || a.id.localeCompare(b.id))
    .map((d) => ({ ...d, leadSeconds: Math.round((lockMs - Date.parse(d.detectedAt)) / 1000) }));

  const checkpoints: ReplayCheckpoint[] = CHECKPOINT_FRACTIONS.map((fraction) => {
    const hours = input.lookbackHours * fraction;
    const at = lockMs - hours * 3_600_000;
    const soFar = admitted.filter((c) => Date.parse(c.observedAt) <= at);
    const types: string[] = [];
    for (const capture of soFar) for (const s of capture.signals) if (!types.includes(s.type)) types.push(s.type);
    const latest = soFar.at(-1) ?? null;
    return {
      label: checkpointLabel(hours),
      at: new Date(at).toISOString(),
      capturesSoFar: soFar.length,
      signalTypesSoFar: types,
      latestCapture: latest ? { observedAt: latest.observedAt, signalTypes: [...new Set(latest.signals.map((s) => s.type))] } : null
    };
  });

  let convergence: ReplayResult["convergence"] = null;
  let firstSignal: ReplayResult["firstSignal"] = null;
  for (const capture of admitted) {
    const types = [...new Set(capture.signals.map((s) => s.type))];
    const leadSeconds = Math.round((lockMs - Date.parse(capture.observedAt)) / 1000);
    if (!firstSignal && types.length > 0) firstSignal = { observedAt: capture.observedAt, leadSeconds, type: types[0]!, captureId: capture.id };
    if (!convergence && types.length >= CONVERGENCE_MIN_SIGNAL_TYPES) {
      convergence = { observedAt: capture.observedAt, leadSeconds, signalTypes: types, captureId: capture.id };
    }
  }

  let largestGapSeconds: number | null = null;
  for (let i = 1; i < admitted.length; i++) {
    const gap = Math.round((Date.parse(admitted[i]!.observedAt) - Date.parse(admitted[i - 1]!.observedAt)) / 1000);
    if (largestGapSeconds === null || gap > largestGapSeconds) largestGapSeconds = gap;
  }

  const verdict: ReplayVerdict = admitted.length === 0 ? "NO_COVERAGE"
    : convergence ? "CONVERGENCE_OBSERVED"
    : firstSignal ? "SIGNALS_OBSERVED"
    : "NOTHING_OBSERVED";

  const lead = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  const answer =
    verdict === "NO_COVERAGE" ? "Unknown. AEGIX stored no capture of this subject in the window, so there is nothing to replay. This is absence of record, not absence of signal."
    : verdict === "CONVERGENCE_OBSERVED" ? `Yes, in part. ${convergence!.signalTypes.length} distinct signal types were stored in one capture ${lead(convergence!.leadSeconds)} before the event.`
    : verdict === "SIGNALS_OBSERVED" ? `Partly. A signal was first stored ${lead(firstSignal!.leadSeconds)} before the event, but no capture held ${CONVERGENCE_MIN_SIGNAL_TYPES} distinct signal types at once.`
    : "No. AEGIX was capturing this subject in the window and no signal met its threshold before the event.";

  const limitations = [
    "The replay shows captures exactly as stored, produced by the engine version current at capture time. Nothing is recomputed with later code or later data.",
    "A stored signal shows that something was observable. It does not show that the event was predictable, and it is not a forecast or advice.",
    "Only captures stored strictly before the event time are admitted."
  ];
  if (verdict !== "NO_COVERAGE" && Date.parse(admitted[0]!.observedAt) - startMs > 3_600_000) {
    limitations.push(`Capture coverage begins at ${admitted[0]!.observedAt}, after the window start; the earlier part of the window has no record.`);
  }
  if (largestGapSeconds !== null && largestGapSeconds > 3 * 3600) {
    limitations.push(`The largest gap between captures is ${lead(largestGapSeconds)}; a signal that appeared and cleared inside a gap is not recorded.`);
  }
  if (context.length > 0) {
    limitations.push("Context signals describe news coverage and fund prices in the window, as stored at the time. They are the surroundings of the subject: nothing links them to it, and they do not enter the answer above.");
  }
  if (discoveries.length > 0) {
    limitations.push("A discovery listed here is a statistical relationship between two series that was on record before the event, shown with the status it had then. It is not a signal about this event.");
  }
  if (admitted.some((c) => c.providerStatus !== "OK" || c.qualityGrade === "LOW")) {
    limitations.push("Some captures were taken with a degraded provider or low data quality; see each capture.");
  }

  return {
    subject: input.subject,
    eventTime: lock.toISOString(),
    lockedAt: lock.toISOString(),
    windowStart: start.toISOString(),
    lookbackHours: input.lookbackHours,
    verdict,
    answer,
    checkpoints,
    convergence,
    firstSignal,
    coverage: {
      captures: admitted.length,
      firstCaptureAt: admitted[0]?.observedAt ?? null,
      lastCaptureAt: admitted.at(-1)?.observedAt ?? null,
      largestGapSeconds,
      excludedByLock
    },
    timeline: admitted,
    context,
    discoveries,
    engineVersions: [...new Set(admitted.flatMap((c) => [c.engineVersion, ...c.signals.map((s) => s.engineVersion)]))].sort(),
    rewindEngineVersion: REWIND_ENGINE_VERSION,
    limitations
  };
}
