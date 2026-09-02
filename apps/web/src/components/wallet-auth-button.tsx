"use client";

/**
 * Connect Wallet / Sign to Login CTA (D6-P §39-§40).
 * Clearly states that signing does not create a transaction and costs no
 * SOL. Surfaces specific errors (rejected connection, rejected signature,
 * unsupported signMessage, expired challenge, invalid signature) instead
 * of a generic failure.
 */

import { useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAegixAuth } from "@/lib/auth";

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

export default function WalletAuthButton() {
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
        <span className="text-xs text-slate-400">
          {auth.user.wallet ? shortWallet(auth.user.wallet) : "Authenticated"}
        </span>
        <button
          onClick={() => void auth.signOut()}
          className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (connected && publicKey) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => void auth.signIn()}
          disabled={auth.busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
        >
          {auth.busy ? "Signing…" : "Sign to Login"}
        </button>
        <span className="text-[11px] text-slate-500">
          Signing does not create a transaction and costs no SOL.
        </span>
        {auth.error && <span className="text-xs text-red-400">{auth.error}</span>}
        <button
          onClick={() => void disconnect()}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => void handleConnect()}
        disabled={connecting}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
      >
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
      <span className="text-[11px] text-slate-500">
        Signing does not create a transaction and costs no SOL.
      </span>
      {auth.error && <span className="text-xs text-red-400">{auth.error}</span>}
    </div>
  );
}
