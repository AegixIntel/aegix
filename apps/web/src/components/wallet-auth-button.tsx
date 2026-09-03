"use client";

/**
 * Connect Wallet / Sign to Login CTA (D6-P §39-§40).
 * Clearly states that signing does not create a transaction and costs no
 * SOL. Surfaces specific errors (rejected connection, rejected signature,
 * unsupported signMessage, expired challenge, invalid signature) instead
 * of a generic failure.
 *
 * `compact` hides the explanatory copy and disconnect link so it fits a
 * navbar; it still shows the connect / sign / sign-out action.
 */

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAegixAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

export default function WalletAuthButton({ compact = false }: { compact?: boolean }) {
  const { select, connected, publicKey, connecting, disconnect } = useWallet();
  const auth = useAegixAuth();

  const handleConnect = useCallback(async () => {
    // The standard adapters render their own wallet selection popup when
    // multiple wallets are registered; the WalletProvider registers
    // Phantom + Solflare. Passing null opens the selection modal.
    try {
      select(null);
    } catch {
      // selection failure surfaces through the wallet UI
    }
  }, [select]);

  if (auth.user) {
    return (
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {auth.user.wallet ? shortWallet(auth.user.wallet) : "Authenticated"}
        </span>
        <button
          onClick={() => void auth.signOut()}
          className="btn-secondary px-3 py-1.5 text-xs"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (connected && publicKey) {
    return (
      <div className={cn("flex items-end gap-1", compact ? "flex-row items-center" : "flex-col")}>
        <button
          onClick={() => void auth.signIn()}
          disabled={auth.busy}
          className="btn-primary whitespace-nowrap px-4 py-2 text-sm"
        >
          {auth.busy ? "Signing…" : "Sign to Login"}
        </button>
        {!compact && (
          <>
            <span className="text-[11px] text-muted-2">
              Signing does not create a transaction and costs no SOL.
            </span>
            <button onClick={() => void disconnect()} className="text-xs text-muted-2 hover:text-muted-foreground">
              Disconnect
            </button>
          </>
        )}
        {auth.error && <span className="text-xs text-red-400">{auth.error}</span>}
      </div>
    );
  }

  return (
    <div className={cn("flex items-end gap-1", compact ? "flex-row items-center" : "flex-col")}>
      <button
        onClick={() => void handleConnect()}
        disabled={connecting}
        className="btn-primary whitespace-nowrap px-4 py-2 text-sm"
      >
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
      {!compact && (
        <span className="text-[11px] text-muted-2">
          Signing does not create a transaction and costs no SOL.
        </span>
      )}
      {auth.error && <span className="text-xs text-red-400">{auth.error}</span>}
    </div>
  );
}
