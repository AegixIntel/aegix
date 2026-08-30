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
