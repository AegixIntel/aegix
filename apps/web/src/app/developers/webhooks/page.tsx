import { DeveloperTabs } from "@/components/developer/developer-tabs";
import WebhooksSection from "@/components/developer/webhooks";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Developer Webhooks",
  description: "Manage AEGIX webhook endpoints and signed deliveries."
};

export default function DevelopersWebhooksPage() {
  return (
    <div className="container-page py-10">
      <header>
        <h1 className="font-display text-2xl font-semibold text-marble">Developer API</h1>
        <p className="mt-1 text-sm text-muted-foreground">Configure webhook endpoints and verify signed deliveries.</p>
      </header>

      <DeveloperTabs />

      <WebhooksSection />
    </div>
  );
}
