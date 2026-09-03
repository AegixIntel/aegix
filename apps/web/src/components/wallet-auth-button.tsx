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
 *
 * A custom AEGIX wallet-picker modal opens on Connect (there is no
 * WalletModalProvider), listing the registered wallets (Phantom, Solflare)
 * and calling wallet-adapter's select() on the chosen wallet.
 */

import { useCallback, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { useAegixAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

export default function WalletAuthButton({ compact = false }: { compact?: boolean }) {
  const { select, wallets, connected, publicKey, connecting, disconnect } = useWallet();
  const auth = useAegixAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(() => {
    setError(null);
    // Open the custom picker (there is no WalletModalProvider installed).
    setModalOpen(true);
  }, []);

  const chooseWallet = useCallback(
    (name: string) => {
      try {
        setModalOpen(false);
        void select(name as WalletName);
      } catch {
        setError("Unable to open that wallet. Is the extension installed?");
      }
    },
    [select]
  );

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
        {modalOpen && (
          <WalletPickerModal wallets={wallets} onClose={() => setModalOpen(false)} onSelect={chooseWallet} />
        )}
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
        {modalOpen && (
          <WalletPickerModal wallets={wallets} onClose={() => setModalOpen(false)} onSelect={chooseWallet} />
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex items-end gap-1", compact ? "flex-row items-center" : "flex-col")}>
      <button
        onClick={handleConnect}
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
      {(auth.error || error) && <span className="text-xs text-red-400">{auth.error ?? error}</span>}
      {modalOpen && (
        <WalletPickerModal wallets={wallets} onClose={() => setModalOpen(false)} onSelect={chooseWallet} />
      )}
    </div>
  );
}

/** Accessible custom wallet picker. */
function WalletPickerModal({
  wallets,
  onClose,
  onSelect
}: {
  wallets: ReturnType<typeof useWallet>["wallets"];
  onClose: () => void;
  onSelect: (name: string) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Select a wallet"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-white/10 bg-ink-deep p-6 shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="section-label-accent">Connect to AEGIX</p>
            <h2 className="mt-2 font-display text-xl font-semibold text-marble">Select a wallet</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1 text-muted-2 hover:text-marble"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted-2">
          Authenticate using your Solana wallet. No transaction. No SOL required.
        </p>

        <div className="mt-5 space-y-2">
          {wallets.map((w) => (
            <button
              key={w.adapter.name}
              type="button"
              onClick={() => onSelect(w.adapter.name)}
              disabled={!w.adapter.readyState || w.adapter.readyState === "Unsupported"}
              className="flex w-full items-center justify-between rounded-md border border-white/10 px-4 py-3 text-left transition hover:border-accent disabled:opacity-40"
            >
              <span className="flex items-center gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-sm bg-white/[0.04] font-display text-sm font-bold text-marble">
                  {w.adapter.name.slice(0, 1)}
                </span>
                <span className="text-sm font-medium text-marble">{w.adapter.name}</span>
              </span>
              {w.adapter.readyState === "Unsupported" ? (
                <span className="font-mono text-[10px] uppercase tracking-wide text-muted-2">Unsupported</span>
              ) : (
                <span className="text-accent-bright">→</span>
              )}
            </button>
          ))}
        </div>

        <p className="mt-5 text-center text-xs text-muted-2">
          Don&apos;t have a wallet?{" "}
          <a href="https://phantom.app/" target="_blank" rel="noreferrer" className="text-marble underline underline-offset-4">
            Get Phantom
          </a>
        </p>
      </div>
    </div>
  );
}
