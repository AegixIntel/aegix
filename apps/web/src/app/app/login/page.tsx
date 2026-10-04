"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import WalletAuthButton from "@/components/wallet-auth-button";

function LoginInner() {
  const { user, ready } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = params.get("returnTo") ?? "/app/dashboard";

  useEffect(() => {
    if (ready && user) {
      router.replace(returnTo);
    }
  }, [ready, user, returnTo, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <p className="section-label-accent">Sign in</p>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight text-ink">
          Connect your wallet.
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          AEGIX uses wallet-only authentication. Connect a Solana wallet and sign the challenge to continue.
          Signing does not create a transaction and costs no SOL.
        </p>
        <div className="mt-6 flex items-center justify-center">
          <WalletAuthButton />
        </div>
        <p className="mt-6 text-xs text-muted-foreground/70">
          {user ? "Signed in — redirecting…" : "Your private keys never leave your wallet."}
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
