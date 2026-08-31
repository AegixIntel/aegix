import type { Timestamp } from "./common.js";

/** Monitor lifecycle status, see docs/milestone-d4.md (D4-A §7). */
export type MonitorStatus = "ACTIVE" | "PAUSED" | "DEGRADED" | "ERROR" | "DISABLED";

/**
 * Allowed monitor schedules, see D4-A §9-§10. Configuration-driven; the
 * EVERY_MINUTE schedule exists only for test environments and is disabled
 * unless MONITOR_TEST_SCHEDULES_ENABLED=true.
 */
export type MonitorScheduleType = "DAILY" | "EVERY_12_HOURS" | "EVERY_6_HOURS" | "EVERY_MINUTE";

export type MonitorCheckStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REUSED" | "DELAYED" | "FAILED";

/** Threat event types, see docs/milestone-d4.md (D4-D §35). */
export type ThreatEventType =
  | "PRIVACY_EXPOSURE_INCREASED"
  | "NEW_ENTITY_EXPOSURE"
  | "NEW_REPEATED_FUNDER"
  | "NEW_STRONG_COUNTERPARTY_LINK"
  | "NEW_CLUSTER_LINK"
  | "NEW_ATTACK_PATH"
  | "ATTACK_PATH_STRENGTHENED"
  | "BEHAVIORAL_FINGERPRINT_STRENGTHENED"
  | "IDENTITY_LINKABILITY_INCREASED"
  | "DATA_QUALITY_DEGRADED";

export type ThreatEventSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ThreatEventState = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "EXPIRED";

export type NotificationChannel = "IN_APP" | "EMAIL";

export type NotificationStatus = "PENDING" | "SENT" | "FAILED" | "SUPPRESSED";

/** Direction of a score change, see D4-C §21. */
export type ChangeDirection = "INCREASED" | "DECREASED" | "UNCHANGED";

export interface ScoreChange {
  previous: number;
  current: number;
  delta: number;
  direction: ChangeDirection;
}

/** Canonical semantic identity of a signal, see D4-C §23 (not the row id). */
export interface SignalIdentity {
  type: string;
  subject: string | null;
  counterparty: string | null;
  entity: string | null;
}

export interface SignalChange {
  identity: SignalIdentity;
  type: string;
  previous: { severity: number; confidence: number } | null;
  current: { severity: number; confidence: number } | null;
  change: "NEW" | "REMOVED" | "CHANGED";
}

export interface DimensionChange {
  key: string;
  label: string;
  change: ScoreChange;
}

export interface EntityChange {
  entityName: string;
  entityType: string | null;
  change: "NEW_ENTITY_EXPOSURE" | "ENTITY_EXPOSURE_REMOVED" | "ENTITY_INTERACTION_INCREASED" | "ENTITY_CONFIDENCE_CHANGED";
  previous: { count: number; confidence: number } | null;
  current: { count: number; confidence: number } | null;
}

export interface RelationshipChange {
  counterparty: string;
  relationshipType: string;
  change: "NEW_REPEATED_COUNTERPARTY" | "NEW_DOMINANT_COUNTERPARTY" | "COUNTERPARTY_CONCENTRATION_INCREASED" | "NEW_FUNDING_SOURCE" | "REPEATED_FUNDING_RELATIONSHIP_CREATED" | "FUNDING_SOURCE_BECAME_DOMINANT";
  previous: { transactionCount: number; concentration: number } | null;
  current: { transactionCount: number; concentration: number } | null;
}

export interface BehaviorChange {
  feature: string;
  change: "ACTIVITY_TIMING_CHANGED" | "PROTOCOL_USAGE_CHANGED" | "TX_FREQUENCY_CHANGED" | "COUNTERPARTY_DIVERSITY_CHANGED" | "ASSET_MOVEMENT_CHANGED";
  previous: number | null;
  current: number | null;
}

export interface AttackPathChange {
  change: "NEW_EXPOSURE_PATH" | "STRONGER_EXPOSURE_PATH" | "PATH_REACHES_NEW_ENTITY" | "PATH_CONFIDENCE_INCREASED";
  pathId: string;
  previous: { pathScore: number; confidence: number } | null;
  current: { pathScore: number; confidence: number };
}

export interface DataQualityChange {
  previous: { score: number; semanticCoverage: number } | null;
  current: { score: number; semanticCoverage: number };
  degraded: boolean;
  material: boolean;
}

export interface Comparability {
  comparable: boolean;
  reason: string | null;
  engineVersionChanged: boolean;
  scoringVersionChanged: boolean;
  previousEngineVersion: string | null;
  currentEngineVersion: string | null;
}

/** Structured exposure diff, see D4-C §33. */
export interface ExposureDiff {
  monitorId: string;
  previousAnalysisId: string;
  currentAnalysisId: string;
  overallChange: ScoreChange;
  dimensionChanges: DimensionChange[];
  newSignals: SignalChange[];
  removedSignals: SignalChange[];
  changedSignals: SignalChange[];
  entityChanges: EntityChange[];
  relationshipChanges: RelationshipChange[];
  behaviorChanges: BehaviorChange[];
  attackPathChanges: AttackPathChange[];
  dataQualityChange: DataQualityChange;
  comparability: Comparability;
  confidence: number;
  diffVersion: string;
  createdAt: string;
}

/** A candidate threat event before rule evaluation, see D4-D. */
export interface ThreatCandidate {
  eventType: ThreatEventType;
  severity: ThreatEventSeverity;
  confidence: number;
  subject: string;
  title: string;
  summary: string;
  explanation: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
}

/** A threat event after persistence, see D4-D §34-§40. */
export interface ThreatEvent {
  id: string;
  monitorId: string;
  userId: string;
  walletId: string;
  diffId: string | null;
  eventType: ThreatEventType;
  severity: ThreatEventSeverity;
  confidence: number;
  subject: string;
  fingerprint: string;
  title: string;
  summary: string;
  explanation: string;
  evidence: Record<string, unknown>;
  state: ThreatEventState;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  createdAt: string;
}

/** Alert rules for one monitor, see D4-E §42-§43. */
export interface MonitorAlertRules {
  id: string;
  monitorId: string;
  minimumSeverity: ThreatEventSeverity;
  minimumConfidence: number;
  overallScoreDeltaThreshold: number;
  notifyNewEntity: boolean;
  notifyNewAttackPath: boolean;
  notifyBehaviorChange: boolean;
  notifyDataQualityDegraded: boolean;
  cooldownHours: number;
  createdAt: string;
  updatedAt: string;
}

/** Alert decision, see D4-E §47 — reasons are persisted for inspectability. */
export interface AlertDecision {
  event: ThreatCandidate;
  action: "NOTIFY" | "SUPPRESSED";
  reasons: string[];
}

/** Notification record, see D4-F §49. */
export interface Notification {
  id: string;
  userId: string;
  monitorId: string | null;
  eventId: string | null;
  channel: NotificationChannel;
  type: string;
  title: string;
  body: string;
  severity: ThreatEventSeverity;
  readAt: Timestamp | null;
  status: NotificationStatus;
  idempotencyKey: string;
  attemptCount: number;
  lastError: string | null;
  sentAt: Timestamp | null;
  createdAt: Timestamp;
}

/** Monitor row joined with wallet/label/exposure for the dashboard, see D4-G. */
export interface MonitorView {
  id: string;
  userId: string;
  walletId: string;
  walletAddress: string;
  savedAnalysisId: string | null;
  label: string | null;
  status: MonitorStatus;
  scheduleType: MonitorScheduleType;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastAnalysisId: string | null;
  baselineAnalysisId: string | null;
  score: number | null;
  confidence: number | null;
  lastAnalyzedAt: string | null;
  unreadNotifications: number;
  createdAt: string;
  updatedAt: string;
}
