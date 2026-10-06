// Browser traffic is same-origin in every production build. Development can
// override this, but defaults to the Next.js /api rewrite below as well.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export interface CreateAnalysisResponse {
  analysisId: string;
  status: string;
  walletAddress: string;
  cached?: boolean;
}

export interface AnalysisStatusResponse {
  analysisId: string;
  status: string;
  progress: number;
}

export interface XRayEvidence {
  key: string;
  value: string | number | boolean;
  label: string;
}

export interface XRaySignal {
  type: string;
  category: string;
  severity: number;
  confidence: number;
  title: string;
  summary: string | null;
  evidence: XRayEvidence[];
  explanation: string;
}

export interface XRayDimension {
  key: string;
  label: string;
  score: number;
}

export interface XRayPath {
  rank: number;
  pathType: string;
  nodes: Array<{ type: string; label: string }>;
  edges: Array<{ source: string; target: string; type: string }>;
  pathScore: number;
  confidence: number;
  summary: string | null;
  explanation: string;
}

export interface WalletXRay {
  analysis: {
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    engineVersion: string | null;
    chainDataUntil: string | null;
    freshUntil: string | null;
  };
  wallet: { address: string };
  coverage: {
    transactionsRequested?: number;
    transactionsReceived?: number;
    transactionsParsed?: number;
    parserFailures?: number;
    rpcFailures?: number;
    unknownProgramCount?: number;
    historyStart?: string | null;
    historyEnd?: string | null;
    parserSuccessRate?: number;
    semanticCoverage?: number;
    fullyParsed?: number;
    partiallyParsed?: number;
    genericParsed?: number;
    transactionsAnalyzed?: number;
    historyCoverageDays?: number | null;
    dataQualityScore?: number | null;
    grade?: "HIGH" | "MEDIUM" | "LOW" | null;
    coverageDisclosure?: {
      scope: "MOST_RECENT_BOUNDED";
      maxSignatures: number;
      maxTransactions: number;
      maxRpcCalls: number;
      maxHistoryDays: number;
      maxExecutionTimeMs: number;
      rpcBudgetExhausted: boolean;
      timeBudgetExhausted: boolean;
      someInteractionsUnclassified: boolean;
    };
    unknownPrograms?: Array<{
      programId: string;
      instructionCount: number;
      transactionCount: number;
      sampleSignatures: string[];
      firstObservedSlot: number;
      lastObservedSlot: number;
    }>;
    components?: {
      historyCoverage?: number;
      transactionCoverage?: number;
      parserSuccess?: number;
      rpcCompleteness?: number;
      knownProgramRatio?: number;
      sampleAdequacy?: number;
    };
  };
  score: {
    overall: number;
    confidence: number;
    scoringVersion: string | null;
  } | null;
  dimensions: XRayDimension[];
  topSignals: XRaySignal[];
  relationships: unknown[];
  entities: unknown[];
  behavior: Record<string, unknown>;
  attackPaths: XRayPath[];
  engineVersions: Record<string, string | null>;
  correlations?: Array<{
    wallet: string;
    score: number;
    confidence: number;
    families: string[];
    classification: string;
  }>;
}

export async function createAnalysis(address: string): Promise<CreateAnalysisResponse> {
  // The session goes with the request: without it the API counts a signed-in
  // visitor's analysis against the anonymous daily limit and not their plan.
  const res = await fetch(`${API_BASE_URL}/v1/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ address })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<CreateAnalysisResponse>;
}

export async function getAnalysisStatus(analysisId: string): Promise<AnalysisStatusResponse> {
  const res = await fetch(`${API_BASE_URL}/v1/analyses/${analysisId}/status`);
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<AnalysisStatusResponse>;
}

export interface LatestAnalysis { wallet: string; latestAnalysisId: string | null; status: string | null; failureCode?: string | null }
export async function getLatestAnalysis(address: string): Promise<LatestAnalysis> {
  const res = await fetch(`${API_BASE_URL}/v1/wallets/${encodeURIComponent(address)}/latest`);
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<LatestAnalysis>;
}

/** Why a failed analysis left no report, in words a visitor can act on. */
export function analysisFailureReason(code: string | null | undefined): string {
  if (code === "INSUFFICIENT_HISTORY") return "This wallet has no on-chain activity yet, so there is nothing to analyze.";
  if (code === "ACCOUNT_NOT_ANALYZABLE") return "This address is a program or token account, not a personal wallet.";
  if (code === "RPC_RATE_LIMITED" || code === "RPC_TIMEOUT" || code === "ANALYSIS_TIMEOUT") return "The Solana network did not answer in time. Try again in a few minutes.";
  return "The analysis could not be completed. Try again in a few minutes.";
}

export async function getWalletXRay(address: string): Promise<WalletXRay> {
  const res = await fetch(`${API_BASE_URL}/v1/wallets/${encodeURIComponent(address)}/x-ray`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("NO_ANALYSIS");
    }
    throw new Error(`Request failed with status ${res.status}`);
  }
  return res.json() as Promise<WalletXRay>;
}

// ---- D3: account classification + saved analyses (dashboard) ----

export interface AccountClassification {
  address: string;
  accountType: string;
  confidence: number;
  protocol: string | null;
  verificationStatus: string | null;
  analysisEligible: boolean;
  evidence: {
    executable: boolean;
    owner: string | null;
    dataLength: number;
    lamports: number;
    knownProtocol: string | null;
    sysvarName: string | null;
    pdaHint: boolean;
  };
}

export interface SavedAnalysis {
  id: string;
  user_id: string;
  wallet_id: string;
  wallet_address: string;
  analysis_id: string | null;
  label: string | null;
  created_at: string;
  score: number | null;
  confidence: number | null;
  status: string | null;
  last_analyzed_at: string | null;
  fresh_until: string | null;
}

/** Reads the wallet session token from localStorage (set by the wallet
 *  auth flow, D6-P). Supabase access tokens are no longer the product
 *  login mechanism. */
export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("aegix_session_token");
}

function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function getAccountClassification(address: string): Promise<AccountClassification> {
  const res = await fetch(`${API_BASE_URL}/v1/accounts/${encodeURIComponent(address)}/classification`);
  if (!res.ok) throw new Error(`Classification failed with status ${res.status}`);
  return res.json() as Promise<AccountClassification>;
}

export async function listSavedAnalyses(): Promise<SavedAnalysis[]> {
  const res = await fetch(`${API_BASE_URL}/v1/me/saved`, { headers: authHeaders() });
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { saved: SavedAnalysis[] };
  return body.saved;
}

export async function saveAnalysis(address: string, label?: string): Promise<SavedAnalysis> {
  const res = await fetch(`${API_BASE_URL}/v1/me/saved`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ address, label: label ?? null })
  });
  if (!res.ok) throw new Error(`Save failed with status ${res.status}`);
  const body = (await res.json()) as { saved: SavedAnalysis };
  return body.saved;
}

export async function deleteSavedAnalysis(address: string): Promise<void> {
  await fetch(`${API_BASE_URL}/v1/me/saved/${encodeURIComponent(address)}`, {
    method: "DELETE",
    headers: authHeaders()
  });
}

// ---- D4: privacy monitors + notifications ----

export interface Monitor {
  id: string;
  user_id: string;
  wallet_id: string;
  wallet_address: string;
  saved_analysis_id: string | null;
  label: string | null;
  /** ENTITLEMENT_PAUSED: paused by the plan's monitor limit (D11), never by the owner. */
  status: "ACTIVE" | "PAUSED" | "ENTITLEMENT_PAUSED" | "DEGRADED" | "ERROR" | "DISABLED";
  schedule_type: "DAILY" | "EVERY_12_HOURS" | "EVERY_6_HOURS" | "EVERY_MINUTE";
  last_checked_at: string | null;
  next_check_at: string | null;
  last_analysis_id: string | null;
  baseline_analysis_id: string | null;
  score: number | null;
  confidence: number | null;
  last_analyzed_at: string | null;
  unread_notifications: string;
  created_at: string;
  updated_at: string;
}

export interface AlertRules {
  id: string;
  monitor_id: string;
  minimum_severity: string;
  minimum_confidence: string;
  overall_score_delta_threshold: number;
  notify_new_entity: boolean;
  notify_new_attack_path: boolean;
  notify_behavior_change: boolean;
  notify_data_quality_degraded: boolean;
  cooldown_hours: number;
  created_at: string;
  updated_at: string;
}

export interface ThreatEvent {
  id: string;
  monitor_id: string;
  user_id: string;
  wallet_id: string;
  diff_id: string | null;
  event_type: string;
  severity: string;
  confidence: string;
  subject: string;
  fingerprint: string;
  title: string;
  summary: string;
  explanation: string;
  evidence: Record<string, unknown>;
  state: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: string;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  monitor_id: string | null;
  event_id: string | null;
  channel: string;
  type: string;
  title: string;
  body: string;
  severity: string;
  read_at: string | null;
  status: string;
  idempotency_key: string;
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

export async function listMonitors(): Promise<Monitor[]> {
  const res = await fetch(`${API_BASE_URL}/v1/me/monitors`, { headers: authHeaders() });
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { monitors: Monitor[] };
  return body.monitors;
}

export async function createMonitor(address: string, scheduleType?: string): Promise<{ monitor: Monitor; rules: AlertRules | null }> {
  const res = await fetch(`${API_BASE_URL}/v1/me/monitors`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ address, scheduleType: scheduleType ?? undefined })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<{ monitor: Monitor; rules: AlertRules | null }>;
}

export interface AlertRulesPatch {
  minimumSeverity?: string;
  minimumConfidence?: number;
  overallScoreDeltaThreshold?: number;
  notifyNewEntity?: boolean;
  notifyNewAttackPath?: boolean;
  notifyBehaviorChange?: boolean;
  notifyDataQualityDegraded?: boolean;
  cooldownHours?: number;
}

export async function updateMonitor(
  id: string,
  patch: { scheduleType?: string; status?: string; alertRules?: AlertRulesPatch }
): Promise<{ monitor: Monitor | null; rules: AlertRules | null }> {
  const res = await fetch(`${API_BASE_URL}/v1/me/monitors/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      scheduleType: patch.scheduleType,
      status: patch.status,
      alertRules: patch.alertRules
    })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<{ monitor: Monitor | null; rules: AlertRules | null }>;
}

export async function deleteMonitor(id: string): Promise<void> {
  await fetch(`${API_BASE_URL}/v1/me/monitors/${id}`, { method: "DELETE", headers: authHeaders() });
}

export async function getMonitorDetail(id: string): Promise<{
  monitor: Monitor | null;
  rules: AlertRules | null;
  events: ThreatEvent[];
  checks: Array<Record<string, unknown>>;
  diffs: Array<Record<string, unknown>>;
}> {
  const res = await fetch(`${API_BASE_URL}/v1/me/monitors/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<{
    monitor: Monitor | null;
    rules: AlertRules | null;
    events: ThreatEvent[];
    checks: Array<Record<string, unknown>>;
    diffs: Array<Record<string, unknown>>;
  }>;
}

export async function listMonitorEvents(id: string): Promise<ThreatEvent[]> {
  const res = await fetch(`${API_BASE_URL}/v1/me/monitors/${id}/events`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { events: ThreatEvent[] };
  return body.events;
}

export async function acknowledgeEvent(id: string): Promise<void> {
  await fetch(`${API_BASE_URL}/v1/me/events/${id}/acknowledge`, { method: "POST", headers: authHeaders() });
}

export interface NotificationListOptions {
  limit?: number;
  cursor?: string;
  unreadOnly?: boolean;
  severity?: string;
  signal?: AbortSignal;
}

export async function listNotifications(options: NotificationListOptions = {}): Promise<{ notifications: Notification[]; unreadCount: number; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.unreadOnly) params.set("unread", "true");
  if (options.severity) params.set("severity", options.severity);
  params.set("channel", "IN_APP");
  const qs = params.toString();
  const res = await fetch(`${API_BASE_URL}/v1/me/notifications${qs ? `?${qs}` : ""}`, { headers: authHeaders(), signal: options.signal });
  if (res.status === 401) return { notifications: [], unreadCount: 0, nextCursor: null };
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<{ notifications: Notification[]; unreadCount: number; nextCursor: string | null }>;
}

export async function markNotificationRead(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/v1/me/notifications/${id}/read`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
}

export async function markAllNotificationsRead(): Promise<number> {
  const res = await fetch(`${API_BASE_URL}/v1/me/notifications/read-all`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { marked: number };
  return body.marked;
}

// ---- D5-I: wallet comparison ----

export interface CompareEvidenceFamily {
  family: string;
  strength: number;
  confidence: number;
  summary: string;
  evidence: XRayEvidence[];
  limitations: string[];
  engineVersion: string;
}

export interface ComparePath {
  id: string;
  pathType: string;
  nodes: Array<{ id: string; type: string; label: string }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    strength: number;
    confidence: number;
    observationClass: string;
    evidence: string[];
    sourceEngine: string;
    engineVersion: string;
  }>;
  pathScore: number;
  confidenceScore: number;
  summary: string;
  explanation: string[];
}

export interface CompareClusterMember {
  wallet: string;
  strengthToCore: number;
  confidence: number;
  evidenceFamilies: string[];
  anchor: string;
  lowData: boolean;
}

export interface CompareCluster {
  id: string;
  targetWallet: string;
  members: CompareClusterMember[];
  confidence: number;
  evidenceFamilies: string[];
  engineVersion: string;
  limitations: string[];
}

export interface CompareCommonalityNote {
  key: string;
  name?: string;
  kind: "COUNTERPARTY" | "ENTITY";
  frequency: number | null;
  distinctWallets: number | null;
  populationSize: number | null;
  treatment: "MEANINGFUL" | "DISCOUNTED" | "HEAVILY_DISCOUNTED" | "STATIC";
}

export interface CompareResult {
  walletA: string;
  walletB: string;
  pairId: string;
  correlation: {
    correlationScore: number;
    confidence: number;
    classification: string;
    evidenceFamilies: CompareEvidenceFamily[];
    limitations: string[];
    engineVersion: string;
    pairId: string;
  };
  analyses: {
    a: { wallet: string; analysisId: string; status: string } | null;
    b: { wallet: string; analysisId: string; status: string } | null;
  };
  relationshipPaths: ComparePath[];
  clusters: CompareCluster[];
  dataQuality: { a: Record<string, unknown> | null; b: Record<string, unknown> | null };
  commonality?: {
    source: "POPULATION" | "STATIC" | "FALLBACK";
    eligible: boolean;
    populationSize: number;
    minimumPopulation: number;
    version: string;
    stale: boolean;
    notes: CompareCommonalityNote[];
  };
  limitations: string[];
  engineVersions: Record<string, string>;
  cached?: boolean;
}

/**
 * The API sends each relationship path as { path, identity, explanation };
 * the page reads the path itself. Read as sent, the first path of any
 * comparison that had one crashed the page.
 */
function withFlatPaths(result: CompareResult): CompareResult {
  const paths = (result.relationshipPaths ?? []) as Array<ComparePath | { path: ComparePath }>;
  return { ...result, relationshipPaths: paths.map((p) => ("path" in p ? p.path : p)) };
}

export async function compareWallets(walletA: string, walletB: string): Promise<CompareResult> {
  const res = await fetch(`${API_BASE_URL}/v1/compare`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ walletA, walletB })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    const err = new Error(body.message ?? `Comparison failed with status ${res.status}`) as Error & { code?: string };
    err.code = body.code;
    throw err;
  }
  return withFlatPaths((await res.json()) as CompareResult);
}

export async function getComparison(pairId: string): Promise<CompareResult> {
  const res = await fetch(`${API_BASE_URL}/v1/compare/${encodeURIComponent(pairId)}`);
  if (!res.ok) throw new Error(`Comparison failed with status ${res.status}`);
  return withFlatPaths((await res.json()) as CompareResult);
}

// ---- D6-A: saved comparisons (authenticated) ----

export interface SavedComparison {
  id: string;
  user_id: string;
  pair_key: string;
  wallet_a: string;
  wallet_b: string;
  comparison_result_id: string | null;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  correlation_score: number | null;
  confidence: string | null;
  classification: string | null;
  engine_version: string | null;
  result_created_at: string | null;
}

export interface SavedComparisonDetail {
  saved: SavedComparison;
  comparison: CompareResult | null;
  stale: boolean;
}

export async function saveComparison(walletA: string, walletB: string, label?: string, notes?: string): Promise<SavedComparison> {
  const res = await fetch(`${API_BASE_URL}/v1/me/saved-comparisons`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ walletA, walletB, label: label ?? null, notes: notes ?? null })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Save failed with status ${res.status}`);
  }
  const body = (await res.json()) as { saved: SavedComparison };
  return body.saved;
}

export async function listSavedComparisons(): Promise<SavedComparison[]> {
  const res = await fetch(`${API_BASE_URL}/v1/me/saved-comparisons?limit=50`, { headers: authHeaders() });
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { saved: SavedComparison[] };
  return body.saved;
}

export async function getSavedComparison(id: string): Promise<SavedComparisonDetail> {
  const res = await fetch(`${API_BASE_URL}/v1/me/saved-comparisons/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<SavedComparisonDetail>;
}

export async function updateSavedComparison(id: string, patch: { label?: string | null; notes?: string | null }): Promise<SavedComparison> {
  const res = await fetch(`${API_BASE_URL}/v1/me/saved-comparisons/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`Update failed with status ${res.status}`);
  const body = (await res.json()) as { saved: SavedComparison };
  return body.saved;
}

export async function deleteSavedComparison(id: string): Promise<void> {
  await fetch(`${API_BASE_URL}/v1/me/saved-comparisons/${id}`, { method: "DELETE", headers: authHeaders() });
}

// ---- D6-C/D: developer API keys + usage (authenticated product UI) ----

export interface DeveloperApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  status: "ACTIVE" | "REVOKED";
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CreatedDeveloperKey {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
}

export interface DeveloperUsageSummary {
  periodStart: string;
  periodEnd: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  breakdown: Array<{ operation: string; units: number }>;
}

export async function listDeveloperKeys(): Promise<DeveloperApiKey[]> {
  const res = await fetch(`${API_BASE_URL}/v1/developer/keys`, { headers: authHeaders() });
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { keys: DeveloperApiKey[] };
  return body.keys;
}

export async function createDeveloperKey(name: string, scopes: string[], expiresInDays?: number): Promise<CreatedDeveloperKey> {
  const res = await fetch(`${API_BASE_URL}/v1/developer/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name, scopes, expiresInDays: expiresInDays ?? null })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Create failed with status ${res.status}`);
  }
  const body = (await res.json()) as { key: CreatedDeveloperKey };
  return body.key;
}

export async function revokeDeveloperKey(id: string): Promise<void> {
  await fetch(`${API_BASE_URL}/v1/developer/keys/${id}/revoke`, { method: "POST", headers: authHeaders() });
}

export async function rotateDeveloperKey(id: string): Promise<CreatedDeveloperKey> {
  const res = await fetch(`${API_BASE_URL}/v1/developer/keys/${id}/rotate`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`Rotate failed with status ${res.status}`);
  const body = (await res.json()) as { key: CreatedDeveloperKey };
  return body.key;
}

/** The portal reads usage with the wallet session; `/v1/developer/usage`
 *  is the API-key endpoint for integrations. */
export async function getDeveloperUsage(): Promise<DeveloperUsageSummary> {
  const res = await fetch(`${API_BASE_URL}/v1/me/developer/usage`, { headers: authHeaders() });
  if (res.status === 401) return { periodStart: "", periodEnd: "", used: 0, limit: 0, remaining: 0, resetAt: "", breakdown: [] };
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<DeveloperUsageSummary>;
}

// ---- D6-H: webhook management (developer portal) ----

export interface Webhook {
  id: string;
  url: string;
  status: "ACTIVE" | "DISABLED";
  eventTypes: string[];
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface CreatedWebhook {
  webhook: Webhook;
  secret: string;
}

export async function listWebhooks(): Promise<Webhook[]> {
  const res = await fetch(`${API_BASE_URL}/v1/webhooks`, { headers: authHeaders() });
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { data: Webhook[] };
  return body.data;
}

export async function createWebhook(url: string, eventTypes: string[]): Promise<CreatedWebhook> {
  const res = await fetch(`${API_BASE_URL}/v1/webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ url, eventTypes })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Create failed with status ${res.status}`);
  }
  const body = (await res.json()) as { data: CreatedWebhook };
  return body.data;
}

export async function updateWebhook(
  id: string,
  patch: { url?: string; eventTypes?: string[]; status?: "ACTIVE" | "DISABLED" }
): Promise<Webhook> {
  const res = await fetch(`${API_BASE_URL}/v1/webhooks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`Update failed with status ${res.status}`);
  const body = (await res.json()) as { data: Webhook };
  return body.data;
}

export async function rotateWebhookSecret(id: string): Promise<{ id: string; secret: string }> {
  const res = await fetch(`${API_BASE_URL}/v1/webhooks/${id}/rotate`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`Rotate failed with status ${res.status}`);
  const body = (await res.json()) as { data: { id: string; secret: string } };
  return body.data;
}

export async function deleteWebhook(id: string): Promise<void> {
  await fetch(`${API_BASE_URL}/v1/webhooks/${id}`, { method: "DELETE", headers: authHeaders() });
}

export async function testWebhook(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/v1/webhooks/${id}/test`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`Test failed with status ${res.status}`);
}

// ---- D7: public aggregate stats (landing page, honest numbers) ----

export interface PublicStats {
  analyses: number | null;
  readyAnalyses: number | null;
  cachedAnalyses: number | null;
  walletsAnalyzed: number | null;
  compareCount: number | null;
  monitors: number | null;
  populationSize: number | null;
  populationEligible: boolean;
  generatedAt: string | null;
}

export async function getPublicStats(): Promise<PublicStats | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/public/stats`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data: PublicStats };
    return body.data;
  } catch {
    return null;
  }
}

// ---- D6-I1: notification-email destination (optional, verified) ----

export interface NotificationEmailState {
  email: string | null;
  verified: boolean;
  verificationPending: boolean;
}

export async function getNotificationEmail(): Promise<NotificationEmailState> {
  const res = await fetch(`${API_BASE_URL}/v1/me/email`, { headers: authHeaders() });
  if (res.status === 401) return { email: null, verified: false, verificationPending: false };
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const body = (await res.json()) as { data: NotificationEmailState };
  return body.data;
}

export async function setNotificationEmail(email: string): Promise<NotificationEmailState> {
  const res = await fetch(`${API_BASE_URL}/v1/me/email`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ email })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Set email failed with status ${res.status}`);
  }
  const body = (await res.json()) as { data: NotificationEmailState };
  return body.data;
}

export async function verifyNotificationEmail(code: string): Promise<NotificationEmailState> {
  const res = await fetch(`${API_BASE_URL}/v1/me/email/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ code })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Verify failed with status ${res.status}`);
  }
  const body = (await res.json()) as { data: NotificationEmailState };
  return body.data;
}

export async function deleteNotificationEmail(): Promise<NotificationEmailState> {
  const res = await fetch(`${API_BASE_URL}/v1/me/email`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`Delete failed with status ${res.status}`);
  const body = (await res.json()) as { data: NotificationEmailState };
  return body.data;
}

// ---- D8: wallet context profile ----

export interface ContextIndicator {
  id: string;
  signalType: string;
  category: string;
  severity: number;
  confidence: number;
  title: string;
  description: string;
  sourceEngine: string;
  engineVersion: string;
  evidence: XRayEvidence[];
  evidenceRefs?: string[];
}

export interface SuppressedIndicator {
  id: string;
  signalType: string;
  category: string;
  reason: "ABSENCE_NOT_EVIDENCE" | "AGGREGATE_OF_LISTED_EVIDENCE" | "INSUFFICIENT_ACTIVITY";
}

export interface WalletContext {
  wallet: string;
  supportingEvidence?: Array<{ id: string; category: string; title: string; description: string; confidence: number; sourceEngine: string; engineVersion: string; evidence: XRayEvidence[]; observedAt: string; analysisId: string | null; limitations: string[] }>;
  analysisId: string;
  sufficiency: "SUFFICIENT" | "INSUFFICIENT_ACTIVITY";
  indicators: ContextIndicator[];
  suppressed: SuppressedIndicator[];
  linkability: {
    converged: boolean;
    contributingCategories: string[];
    severity: number | null;
    confidence: number | null;
    note: string;
  };
  knownRisk: { dataset: string; match: string; note: string };
  dimensions: XRayDimension[];
  coverage: {
    transactionsParsed: number;
    historyStart: string | null;
    historyEnd: string | null;
    dataQualityScore: number | null;
    grade: string | null;
  };
  limitations: string[];
  engineVersions: { context: string; pipeline: string | null; scoring: string | null };
}

export async function getWalletContext(address: string): Promise<WalletContext> {
  const res = await fetch(`${API_BASE_URL}/v1/wallets/${encodeURIComponent(address)}/context`, {
    headers: authHeaders()
  });
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<WalletContext>;
}

// ---- D9: Ask AEGIX ----

export interface AskFinding {
  statement: string;
  evidenceIds: string[];
}

export interface AskAnswer {
  summary: string;
  findings: AskFinding[];
  limitations: string[];
}

export interface AskResponse {
  wallet: string;
  analysisId: string;
  question: string;
  answer: AskAnswer;
  evidenceOffered: string[];
  contextTruncated: boolean;
  contextDropped: number;
  citationsDropped: number;
  findingsDropped: number;
  model: string;
  engineVersion: string;
}

export interface AskUnavailable {
  code: "AI_UNAVAILABLE" | "QUOTA_EXCEEDED" | "FEATURE_DISABLED";
  reason?: string;
  message: string;
}

export class AskAegixError extends Error {
  readonly detail: AskUnavailable;
  constructor(detail: AskUnavailable) {
    super(detail.message);
    this.name = "AskAegixError";
    this.detail = detail;
  }
}

export async function askAegix(address: string, question: string): Promise<AskResponse> {
  const res = await fetch(`${API_BASE_URL}/v1/wallets/${encodeURIComponent(address)}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ question })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as AskUnavailable | null;
    throw new AskAegixError(
      body ?? { code: "AI_UNAVAILABLE", message: `Request failed with status ${res.status}` }
    );
  }
  return res.json() as Promise<AskResponse>;
}

export type MarketAsset = "BTC" | "ETH" | "SOL";
export interface MarketResponse {
  asset: MarketAsset;
  snapshot: import("@aegix/markets").MarketSnapshot;
  temporalContext: Array<{ id: string; evidenceRefs: string[]; marketTimestamp: string; onChainTimestamp: string; priceUsd: number; offsetSeconds: number; note: string }>;
  contextLimitations?: string[];
  quota: { used: number; limit: number; resetAt: string };
}
export async function getMarket(asset: MarketAsset, wallet?: string): Promise<MarketResponse> {
  const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
  const response = await fetch(`${API_BASE_URL}/v1/markets/${asset}${query}`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? body?.message ?? body?.code ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<MarketResponse>;
}
export async function askMarket(asset: MarketAsset, question: string, wallet?: string): Promise<AskResponse> {
  const response = await fetch(`${API_BASE_URL}/v1/markets/${asset}/ask`, {
    method: "POST", headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ question, ...(wallet ? { wallet } : {}) })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new AskAegixError({ code: body?.code ?? "AI_UNAVAILABLE", reason: body?.reason,
      message: body?.message ?? "Market explanation is unavailable" });
  }
  return { ...(await response.json()), wallet: wallet ?? asset, analysisId: "" } as AskResponse;
}

// ---- D11: billing / entitlements ----

export type PlanCode = "free" | "pro" | "team";

export interface BillingPlan {
  code: PlanCode;
  name: string;
  tier: number;
  priceCents: number;
  currency: string;
  interval: "NONE" | "MONTH" | "YEAR";
  entitlements: Record<string, number>;
  catalogVersion: string;
}

export interface BillingPlansResponse {
  plans: BillingPlan[];
  currency: string;
  /** False while no payment provider is configured: upgrades are granted. */
  selfServe: boolean;
  provider: string;
}

export interface BillingSubscription {
  plan: BillingPlan | null;
  subscribedPlan: BillingPlan | null;
  status: "NONE" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";
  /** True when the plan being paid for is not the plan being enforced. */
  degraded: boolean;
  entitlements: Record<string, number>;
  period: { start: string; end: string };
  cancelAtPeriodEnd: boolean;
  gracePeriodEnd: string | null;
  trialEnd: string | null;
  selfServe: boolean;
  /** The identity's open request for a paid plan, awaiting manual activation. */
  upgradeRequest: { plan: PlanCode; status: "OPEN"; requestedAt: string } | null;
  engineVersion: string;
}

export interface BillingUsageDimension {
  dimension: string;
  units: number;
  entitlementKey: string | null;
  limit: number | null;
  includedUnits: number | null;
  overageUnits: number;
}

export interface BillingUsage {
  planCode: PlanCode;
  period: { start: string; end: string };
  days: number;
  dimensions: BillingUsageDimension[];
  engineVersion: string;
}

export interface BillingInvoice {
  id: string;
  plan_code: string;
  currency: string;
  period_start: string;
  period_end: string;
  status: "DRAFT" | "OPEN" | "PAID" | "VOID";
  lines: Array<{ kind: string; description: string; quantity: number; unitCents: number; amountCents: number }>;
  subtotal_cents: number;
  total_cents: number;
  issued_at: string | null;
  paid_at: string | null;
}

async function billingRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...authHeaders(), ...init?.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? body?.message ?? body?.code ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getBillingPlans(): Promise<BillingPlansResponse> {
  return billingRequest<BillingPlansResponse>("/v1/billing/plans");
}

export function getBillingSubscription(): Promise<BillingSubscription> {
  return billingRequest<BillingSubscription>("/v1/billing/subscription");
}

export function getBillingUsage(): Promise<BillingUsage> {
  return billingRequest<BillingUsage>("/v1/billing/usage");
}

export function getBillingInvoices(): Promise<{ invoices: BillingInvoice[] }> {
  return billingRequest<{ invoices: BillingInvoice[] }>("/v1/billing/invoices");
}

export function cancelSubscription(immediate = false): Promise<{ status: string; cancelAtPeriodEnd: boolean; effectiveAt: string }> {
  return billingRequest("/v1/billing/subscription/cancel", { method: "POST", body: JSON.stringify({ immediate }) });
}

export function resumeSubscription(): Promise<{ status: string; cancelAtPeriodEnd: boolean }> {
  return billingRequest("/v1/billing/subscription/resume", { method: "POST" });
}

/** Asks the AEGIX team for a paid plan. Grants nothing until an operator activates it. */
export function requestUpgrade(plan: PlanCode, contact: string): Promise<{ request: { plan: PlanCode; status: "OPEN"; requestedAt: string } }> {
  const trimmed = contact.trim();
  return billingRequest("/v1/billing/upgrade-request", {
    method: "POST",
    body: JSON.stringify(trimmed ? { plan, contact: trimmed } : { plan })
  });
}

export type RewindSubjectType = "asset" | "wallet";
export type RewindResponse = import("@aegix/rewind").ReplayResult & { subjectType: RewindSubjectType };
export async function rewind(input: { subjectType: RewindSubjectType; subject: string; eventTime: string; lookbackHours: number }): Promise<RewindResponse> {
  const response = await fetch(`${API_BASE_URL}/v1/rewind`, {
    method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(input)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? body?.message ?? body?.code ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<RewindResponse>;
}

export interface RewindSubject { subject: string; label: string; kind: "MARKET_ASSET" | "TOKENIZED_STOCK" }
export async function getRewindSubjects(): Promise<RewindSubject[]> {
  const response = await fetch(`${API_BASE_URL}/v1/rewind/subjects`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? body?.message ?? body?.code ?? `Request failed (${response.status})`);
  }
  return ((await response.json()) as { assets: RewindSubject[] }).assets;
}

export interface DiscoverySummary {
  id: string;
  status: "CANDIDATE" | "CONFIRMED" | "NOT_CONFIRMED";
  firstDetectedAt: string;
  seriesA: string;
  seriesB: string;
  lagHours: number;
  direction: "POSITIVE" | "NEGATIVE";
  engineVersion: string;
  fingerprint: string;
  prevChainHash: string | null;
  chainHash: string;
  card: import("@aegix/discovery").DiscoveryCard;
}
export interface DiscoveryRunSummary {
  epochEnd: string; completedAt: string; engineVersion: string; method: string; fdrLevel: number;
  seriesCount: number; hypothesesConsidered: number; hypothesesTested: number; rejections: number;
}
export interface DiscoveryListResponse { discoveries: DiscoverySummary[]; latestRun: DiscoveryRunSummary | null }
export interface DiscoveryDetailResponse {
  discovery: DiscoverySummary;
  run: DiscoveryRunSummary | null;
  events: Array<{ type: string; at: string; detail: Record<string, unknown> }>;
  related: Array<{ id: string; status: string; seriesA: string; seriesB: string; lagHours: number; direction: string; firstDetectedAt: string }>;
  /** Calendar receipts for the earliest anchored chain head that includes this discovery. */
  anchors: DiscoveryAnchor[];
}
export interface DiscoveryAnchor { id: string; covers: string; chainHash: string; calendar: string; submittedAt: string; proofPath: string }
/** Where a proof file is downloaded from. Public: it needs no session. */
export function discoveryProofUrl(anchor: DiscoveryAnchor): string {
  return `${API_BASE_URL}${anchor.proofPath}`;
}
async function getDiscoveryJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? body?.message ?? body?.code ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export function listDiscoveries(): Promise<DiscoveryListResponse> {
  return getDiscoveryJson("/v1/discoveries");
}
export function getDiscovery(id: string): Promise<DiscoveryDetailResponse> {
  return getDiscoveryJson(`/v1/discoveries/${encodeURIComponent(id)}`);
}
