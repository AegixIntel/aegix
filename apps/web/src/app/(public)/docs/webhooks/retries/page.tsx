import { DocHeading, DocSection, DocList } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Webhook Retries" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Webhooks" title="Retries" lead="How AEGIX handles transient delivery failures." />
      <DocSection title="Retry policy">
        <DocList items={[
          "Transient failures (5xx, 408, 429, network errors, timeouts) are retried with exponential backoff.",
          "Up to WEBHOOK_MAX_ATTEMPTS (8 by default) attempts.",
          "Permanent failures (4xx except 408/429) disable the webhook — no further retries until you re-enable it."
        ]} />
      </DocSection>
      <DocSection title="SSRF protection">
        <p>Destinations are resolved and validated at delivery time; private/loopback/link-local/metadata addresses are rejected. Redirects are never followed — treat a 3xx as a permanent failure.</p>
      </DocSection>
    </div>
  );
}
