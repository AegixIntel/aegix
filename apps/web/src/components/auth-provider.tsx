"use client";

/**
 * Auth context provider for the product (D6-P). Wraps the app in the
 * wallet-adapter providers + the session hook so any client component can
 * read auth state. Pages using server-side rendering must render this
 * inside a client boundary (the layout).
 */

import { createContext, useContext } from "react";
import { AegixWalletProvider, useAegixAuth, type AuthState } from "@/lib/auth";

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <AegixWalletProvider>
      <AuthStateBridge>{children}</AuthStateBridge>
    </AegixWalletProvider>
  );
}

function AuthStateBridge({ children }: { children: React.ReactNode }) {
  const state = useAegixAuth();
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback: outside a provider (e.g. a server-rendered page). Return a
    // stable unauthenticated state; pages render the Connect CTA.
    return { user: null, ready: true, connectedWallet: null, error: null, busy: false, signIn: async () => {}, signOut: async () => {} };
  }
  return ctx;
}
