"use client";

/**
 * Auth context provider for the product (D6-P). Holds the session and the
 * sign-in flow so any client component can read auth state. Pages using
 * server-side rendering must render this inside a client boundary (the
 * layout).
 *
 * The wallet libraries are not part of this module. They are fetched when a
 * wallet is wanted: a visitor presses Connect, or has a session or a
 * remembered wallet from an earlier visit. A first-time visitor reading a
 * public page never downloads them.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  NO_WALLET, SESSION_TOKEN_KEY, WALLET_NAME_KEY, clearSessionToken, fetchMe, getSessionToken, requestChallenge, revokeSession, verifySignature,
  type AuthState, type AuthUser, type WalletView
} from "@/lib/auth";

const WalletIsland = dynamic(() => import("@/components/wallet-island"), { ssr: false });

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [walletWanted, setWalletWanted] = useState(false);
  const [wallet, setWallet] = useState<WalletView>(NO_WALLET);
  const loadWallet = useCallback(() => setWalletWanted(true), []);

  // Restore the session from storage on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = getSessionToken();
      // A returning visitor's wallet reconnects by itself, and a signed-in
      // one must be watched for an account switch: both need the libraries.
      if (token || window.localStorage.getItem(WALLET_NAME_KEY)) setWalletWanted(true);
      if (!token) {
        if (!cancelled) setReady(true);
        return;
      }
      let me = await fetchMe(token);
      if (me === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        me = await fetchMe(token);
      }
      if (!cancelled) {
        // Only an invalid session clears the stored token; a transient failure
        // keeps it so the next page load restores the session.
        if (me === null) clearSessionToken();
        setUser(me ?? null);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Account switch (D6-P §41): the connected wallet changed → never stay
  // authenticated as the previous user.
  const { connected, address, signMessage, disconnect } = wallet;
  useEffect(() => {
    if (!connected || !address) return;
    if (user && user.wallet && user.wallet !== address) {
      clearSessionToken();
      setUser(null);
      setError("Wallet account switched — please sign in again.");
    }
  }, [address, connected, user]);

  const signIn = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (!connected || !address) {
        throw new Error("Please connect your wallet first.");
      }
      if (!signMessage) {
        throw new Error("This wallet does not support message signing (signMessage).");
      }
      const { challengeId, message, nonce } = await requestChallenge(address);
      const signature = await signMessage(new TextEncoder().encode(message));
      // The API expects base58-encoded signatures.
      const bs58 = (await import("bs58")).default;
      const { token, user: me } = await verifySignature({
        challengeId,
        wallet: address,
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
  }, [connected, address, signMessage]);

  const signOut = useCallback(async () => {
    const token = getSessionToken();
    if (token) await revokeSession(token);
    clearSessionToken();
    setUser(null);
    setError(null);
    if (connected) await disconnect().catch(() => {});
  }, [connected, disconnect]);

  const state = useMemo<AuthState>(
    () => ({ user, ready, connectedWallet: address, error, signIn, signOut, busy: busy || wallet.connecting, wallet, loadWallet }),
    [user, ready, address, error, signIn, signOut, busy, wallet, loadWallet]
  );

  return (
    <AuthContext.Provider value={state}>
      {children}
      {walletWanted ? <WalletIsland onChange={setWallet} /> : null}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback: outside a provider (e.g. a server-rendered page). Return a
    // stable unauthenticated state; pages render the Connect CTA.
    return { user: null, ready: true, connectedWallet: null, error: null, busy: false, signIn: async () => {}, signOut: async () => {}, wallet: NO_WALLET, loadWallet: () => {} };
  }
  return ctx;
}
