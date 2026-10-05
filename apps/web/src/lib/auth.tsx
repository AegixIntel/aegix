/**
 * Wallet-only authentication client (D6-P), see docs/d6-block2.md.
 *
 * Flow: connect wallet → request challenge → signMessage (exact message)
 * → verify → session token stored in localStorage. The session token is
 * sent as `Authorization: Bearer <token>` by the API client.
 *
 * Never sends transactions, never requests private keys, and explicitly
 * tells the user that signing costs no SOL.
 *
 * This module holds the session and the two API calls of the flow and
 * imports nothing from the wallet libraries: those are a few hundred
 * kilobytes and live in components/wallet-island.tsx, which a page loads
 * only when a wallet is wanted.
 */

import { API_BASE_URL } from "./api";

export const SESSION_TOKEN_KEY = "aegix_session_token";
/** Where wallet-adapter remembers the wallet a visitor chose. */
export const WALLET_NAME_KEY = "walletName";

export interface AuthUser {
  id: string;
  wallet: string | null;
  email: string | null;
}

/** A wallet the visitor can pick, as the picker shows it. */
export interface WalletOption {
  name: string;
  icon: string;
  readyState: string;
}

/** The wallet libraries' state, as the rest of the app sees it. */
export interface WalletView {
  /** False until the wallet libraries have been loaded and have reported once. */
  loaded: boolean;
  connected: boolean;
  connecting: boolean;
  address: string | null;
  wallets: WalletOption[];
  select: (name: string) => void;
  disconnect: () => Promise<void>;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
}

export const NO_WALLET: WalletView = {
  loaded: false, connected: false, connecting: false, address: null, wallets: [],
  select: () => {}, disconnect: async () => {}, signMessage: null
};

export interface AuthState {
  /** Live wallet session user, or null when signed out. */
  user: AuthUser | null;
  /** Whether a session was loaded from storage. */
  ready: boolean;
  connectedWallet: string | null;
  error: string | null;
  busy: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  wallet: WalletView;
  /** Fetches the wallet libraries if they are not on the page yet. */
  loadWallet: () => void;
}

export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_TOKEN_KEY);
}

export function clearSessionToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_TOKEN_KEY);
}

export async function requestChallenge(wallet: string): Promise<{
  challengeId: string;
  message: string;
  nonce: string;
}> {
  const res = await fetch(`${API_BASE_URL}/v1/auth/wallet/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet })
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Challenge failed (${res.status})`);
  }
  const body = (await res.json()) as { data: { challengeId: string; message: string; nonce: string } };
  return body.data;
}

export async function verifySignature(input: {
  challengeId: string;
  wallet: string;
  signature: string;
  nonce: string;
}): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${API_BASE_URL}/v1/auth/wallet/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Verification failed (${res.status})`);
  }
  const body = (await res.json()) as { data: { token: string; user: AuthUser } };
  return body.data;
}

/** `null` means the session is invalid (401). `undefined` means the API could
 *  not answer — a rate limit, a 5xx or the network — which says nothing about
 *  the session and must not sign the user out. */
export async function fetchMe(token: string): Promise<AuthUser | null | undefined> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return null;
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data: AuthUser };
    return body.data;
  } catch {
    return undefined;
  }
}

/** Revokes the session on the server; best-effort, the local clear always happens. */
export async function revokeSession(token: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch {
    // nothing to do: the token is cleared locally either way
  }
}
