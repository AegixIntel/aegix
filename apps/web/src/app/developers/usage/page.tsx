import { DeveloperTabs } from "@/components/developer/developer-tabs";
import UsageSection from "@/components/developer/usage";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Developer Usage",
  description: "AEGIX developer API usage and quota."
};

export default function DevelopersUsagePage() {
  return (
    <div className="container-page py-10">
      <header>
        <h1 className="font-display text-2xl font-semibold text-marble">Developer API</h1>
        <p className="mt-1 text-sm text-muted-foreground">Monitor your API usage and quota.</p>
      </header>

      <DeveloperTabs />

      <UsageSection />
    </div>
  );
}
