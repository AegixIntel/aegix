/**
 * Wallet-only authentication client (D6-P), see docs/d6-block2.md.
 *
 * Flow: connect wallet → request challenge → signMessage (exact message)
 * → verify → session token stored in localStorage. The session token is
 * sent as `Authorization: Bearer <token>` by the API client.
 *
 * Never sends transactions, never requests private keys, and explicitly
 * tells the user that signing costs no SOL.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import { API_BASE_URL } from "./api";

export const SESSION_TOKEN_KEY = "aegix_session_token";

export interface AuthUser {
  id: string;
  wallet: string | null;
  email: string | null;
}

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
}

export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_TOKEN_KEY);
}

export function clearSessionToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_TOKEN_KEY);
}

/** Wallet-adapter wallets; no vendor hard-coding beyond the standard adapters. */
export function AegixWalletProvider({ children }: { children: React.ReactNode }) {
  const network = WalletAdapterNetwork.Mainnet;
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL ?? clusterApiUrl(network);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

async function requestChallenge(wallet: string): Promise<{
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

async function verifySignature(input: {
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

async function fetchMe(token: string): Promise<AuthUser | null> {
  const res = await fetch(`${API_BASE_URL}/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) return null;
  if (!res.ok) return null;
  const body = (await res.json()) as { data: AuthUser };
  return body.data;
}

export function useAegixAuth(): AuthState {
  const { publicKey, connected, signMessage, disconnect, connecting } = useWallet();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Restore the session from storage on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = getSessionToken();
      if (!token) {
        if (!cancelled) setReady(true);
        return;
      }
      const me = await fetchMe(token);
      if (!cancelled) {
        if (!me) clearSessionToken();
        setUser(me);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Account switch (D6-P §41): the connected wallet changed → never stay
  // authenticated as the previous user.
  const walletStr = publicKey?.toBase58() ?? null;
  useEffect(() => {
    if (!connected || !walletStr) return;
    if (user && user.wallet && user.wallet !== walletStr) {
      clearSessionToken();
      setUser(null);
      setError("Wallet account switched — please sign in again.");
    }
  }, [walletStr, connected, user]);

  const signIn = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (!connected || !publicKey) {
        throw new Error("Please connect your wallet first.");
      }
      if (!signMessage) {
        throw new Error("This wallet does not support message signing (signMessage).");
      }
      const wallet = publicKey.toBase58();
      const { challengeId, message, nonce } = await requestChallenge(wallet);
      const signature = await signMessage(new TextEncoder().encode(message));
      // The API expects base58-encoded signatures.
      const bs58 = (await import("bs58")).default;
      const { token, user: me } = await verifySignature({
        challengeId,
        wallet,
        signature: bs58.encode(signature),
        nonce
      });
      window.localStorage.setItem(SESSION_TOKEN_KEY, token);
      setUser(me);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }, [connected, publicKey, signMessage]);

  const signOut = useCallback(async () => {
    const token = getSessionToken();
    if (token) {
      try {
        await fetch(`${API_BASE_URL}/v1/auth/logout`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` }
        });
      } catch {
        // server revocation is best-effort here; local clear always happens
      }
    }
    clearSessionToken();
    setUser(null);
    setError(null);
    if (connected) await disconnect().catch(() => {});
  }, [connected, disconnect]);

  return {
    user,
    ready,
    connectedWallet: walletStr,
    error,
    signIn,
    signOut,
    busy: busy || connecting
  };
}

export { useWallet };
