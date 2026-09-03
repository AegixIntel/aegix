import { DeveloperTabs } from "@/components/developer/developer-tabs";
import ApiKeysSection from "@/components/developer/api-keys";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Keys",
  description: "AEGIX developer API keys — create, scope, revoke and rotate."
};

export default function DevelopersApiKeysPage() {
  return (
    <div className="container-page py-10">
      <header>
        <h1 className="font-display text-2xl font-semibold text-marble">Developer API</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage API keys for the AEGIX developer platform.</p>
      </header>

      <DeveloperTabs />

      <div className="mt-8">
        <ApiKeysSection />
      </div>
    </div>
  );
}
