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
 * The wallet picker is a dropdown anchored below the Connect button (there
 * is no WalletModalProvider), listing registered wallets (Phantom, Solflare)
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

export default function WalletAuthButton({
  compact = false,
  buttonClassName
}: {
  compact?: boolean;
  buttonClassName?: string;
}) {
  const { select, wallets, connected, publicKey, connecting, disconnect } = useWallet();
  const auth = useAegixAuth();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(() => {
    setError(null);
    setOpen((v) => !v);
  }, []);

  const chooseWallet = useCallback(
    (name: string) => {
      try {
        setOpen(false);
        void select(name as WalletName);
      } catch {
        setError("Unable to open that wallet. Is the extension installed?");
      }
    },
    [select]
  );

  const close = useCallback(() => setOpen(false), []);

  const picker = open ? (
    <WalletPickerPopover wallets={wallets} onClose={close} onSelect={chooseWallet} />
  ) : null;

  if (auth.user) {
    return (
      <div className="relative flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {auth.user.wallet ? shortWallet(auth.user.wallet) : "Authenticated"}
        </span>
        <button
          onClick={() => void auth.signOut()}
          className={cn("btn-secondary px-3 py-1.5 text-xs", buttonClassName)}
        >
          Sign out
        </button>
        {picker}
      </div>
    );
  }

  if (connected && publicKey) {
    return (
      <div className={cn("relative flex items-end gap-1", compact ? "flex-row items-center" : "flex-col")}>
        <button
          onClick={() => void auth.signIn()}
          disabled={auth.busy}
          className={cn("btn-primary whitespace-nowrap px-4 py-2 text-sm", buttonClassName)}
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
        {auth.error && <span className="text-xs text-red-700">{auth.error}</span>}
        {picker}
      </div>
    );
  }

  return (
    <div className={cn("relative flex items-end gap-1", compact ? "flex-row items-center" : "flex-col")}>
      <button
        onClick={handleConnect}
        disabled={connecting}
        className={cn("btn-primary whitespace-nowrap px-4 py-2 text-sm", buttonClassName)}
      >
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
      {!compact && (
        <span className="text-[11px] text-muted-2">
          Signing does not create a transaction and costs no SOL.
        </span>
      )}
      {(auth.error || error) && <span className="text-xs text-red-700">{auth.error ?? error}</span>}
      {picker}
    </div>
  );
}

/** Dropdown anchored below the Connect button. */
function WalletPickerPopover({
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
      className="absolute right-0 top-full z-[100] mt-2 w-72 rounded-lg border border-ink/10 bg-paper p-4 shadow-2xl shadow-ink/20"
      role="dialog"
      aria-label="Select a wallet"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="section-label-accent">Connect to AEGIX</p>
          <h2 className="mt-1.5 font-display text-base font-semibold text-ink">Select a wallet</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-sm p-1 text-muted-2 hover:text-ink"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-2">
        Authenticate using your Solana wallet. No transaction. No SOL required.
      </p>

      <div className="mt-4 space-y-1.5">
        {wallets.map((w) => (
          <button
            key={w.adapter.name}
            type="button"
            onClick={() => onSelect(w.adapter.name)}
            disabled={!w.adapter.readyState || w.adapter.readyState === "Unsupported"}
            className="flex w-full items-center justify-between rounded-md border border-ink/10 px-3 py-2.5 text-left transition hover:border-accent disabled:opacity-40"
          >
            <span className="flex items-center gap-2.5">
              {w.adapter.icon ? (
                <img
                  src={w.adapter.icon}
                  alt=""
                  className="inline-flex h-6 w-6 shrink-0 rounded-sm"
                  width={24}
                  height={24}
                />
              ) : (
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-ink/[0.04] font-display text-sm font-bold text-ink">
                  {w.adapter.name.slice(0, 1)}
                </span>
              )}
              <span className="text-sm font-medium text-ink">{w.adapter.name}</span>
            </span>
            {w.adapter.readyState === "Unsupported" ? (
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-2">Unsupported</span>
            ) : (
              <span className="text-accent-ink">→</span>
            )}
          </button>
        ))}
      </div>

      <p className="mt-4 text-center text-xs text-muted-2">
        Don&apos;t have a wallet?{" "}
        <a href="https://phantom.app/" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-4">
          Get Phantom
        </a>
      </p>
    </div>
  );
}
