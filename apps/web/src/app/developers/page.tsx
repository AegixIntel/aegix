"use client";

import { useAuth } from "@/components/auth-provider";
import { DeveloperTabs } from "@/components/developer/developer-tabs";
import ApiKeysSection from "@/components/developer/api-keys";

export default function DevelopersIndexPage() {
  const { user } = useAuth();

  return (
    <div className="container-page py-10">
      <header>
        <h1 className="font-display text-2xl font-semibold text-ink">Developer API</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage API keys, usage, and webhooks for the AEGIX developer platform.</p>
      </header>

      <DeveloperTabs />

      {!user && (
        <div className="mt-6 rounded-xl border border-amber-600/40 bg-amber-500/10 p-4 text-sm text-amber-800">
          You are browsing anonymously. Connect a Solana wallet to create API keys and manage webhooks.
          Signing in is free — it does not create a transaction and does not cost SOL.
        </div>
      )}

      <div className="mt-8">
        <ApiKeysSection />
      </div>
    </div>
  );
}
