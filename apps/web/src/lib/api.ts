export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
}

export async function createAnalysis(address: string): Promise<CreateAnalysisResponse> {
  const res = await fetch(`${API_BASE_URL}/v1/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

export async function getLatestAnalysis(address: string): Promise<{ wallet: string; latestAnalysisId: string | null; status: string | null }> {
  const res = await fetch(`${API_BASE_URL}/v1/wallets/${encodeURIComponent(address)}/latest`);
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<{ wallet: string; latestAnalysisId: string | null; status: string | null }>;
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

/** Reads the Supabase access token from localStorage (set by the auth UI). */
export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("aegix_access_token");
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
  status: "ACTIVE" | "PAUSED" | "DEGRADED" | "ERROR" | "DISABLED";
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

export async function listNotifications(): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const res = await fetch(`${API_BASE_URL}/v1/me/notifications`, { headers: authHeaders() });
  if (res.status === 401) return { notifications: [], unreadCount: 0 };
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return res.json() as Promise<{ notifications: Notification[]; unreadCount: number }>;
}

export async function markNotificationRead(id: string): Promise<void> {
  await fetch(`${API_BASE_URL}/v1/me/notifications/${id}/read`, { method: "POST", headers: authHeaders() });
}
