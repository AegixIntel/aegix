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
