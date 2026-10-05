"use client";

/**
 * The wallet libraries, kept off the page until a wallet is wanted.
 *
 * Rendered beside the app, not around it: mounting it does not remount the
 * page. It holds wallet-adapter's providers and reports their state upward
 * through `onChange`; nothing else in the app imports a wallet library.
 */

import { useEffect, useMemo } from "react";
import { WalletAdapterNetwork, type WalletName } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";
import type { WalletView } from "@/lib/auth";

function Reporter({ onChange }: { onChange: (view: WalletView) => void }) {
  const { publicKey, connected, connecting, wallets, select, disconnect, signMessage } = useWallet();
  const address = publicKey?.toBase58() ?? null;
  // A wallet's readiness changes when its extension announces itself, without the list changing.
  const readiness = wallets.map((w) => `${w.adapter.name}:${w.readyState}`).join("|");

  useEffect(() => {
    onChange({
      loaded: true,
      connected,
      connecting,
      address,
      wallets: wallets.map((w) => ({ name: w.adapter.name, icon: w.adapter.icon, readyState: w.readyState })),
      select: (name) => select(name as WalletName),
      disconnect,
      signMessage: signMessage ?? null
    });
    // `wallets` is covered by `readiness`.
  }, [onChange, connected, connecting, address, readiness, select, disconnect, signMessage]);

  return null;
}

/** Wallet-adapter wallets; no vendor hard-coding beyond the standard adapters. */
export default function WalletIsland({ onChange }: { onChange: (view: WalletView) => void }) {
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL ?? clusterApiUrl(WalletAdapterNetwork.Mainnet);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <Reporter onChange={onChange} />
      </WalletProvider>
    </ConnectionProvider>
  );
}
