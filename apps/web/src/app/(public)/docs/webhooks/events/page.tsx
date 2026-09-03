import { DocHeading, DocSection, DocList, DocCode } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Webhook Events" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Webhooks" title="Events" lead="The event types AEGIX can deliver." />
      <DocSection title="Event types">
        <DocList items={[
          "monitor.threat.created — a monitored-wallet threat event",
          "correlation.appeared — a new observable correlation crossed your threshold",
          "correlation.increased — a persisted correlation increased meaningfully",
          "correlation.decreased — a persisted correlation left the strong band",
          "correlation.disappeared — a persisted correlation is no longer present"
        ]} />
      </DocSection>
      <DocSection title="Envelope">
        <DocCode>{`{ "id": "uuid", "type": "monitor.threat.created", "createdAt": "...", "data": {} }`}</DocCode>
      </DocSection>
      <DocSection title="Importance">
        <p>AEGIX reports observable relationships and correlation evidence. Correlation does not establish common ownership or real-world identity.</p>
      </DocSection>
    </div>
  );
}
