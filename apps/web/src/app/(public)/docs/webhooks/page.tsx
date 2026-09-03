import { DocHeading, DocSection, DocList, DocCode } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Webhooks" };

export default function WebhooksDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Webhooks" title="Overview" lead="AEGIX delivers signed webhook events to your endpoint." />

      <DocSection title="Event envelope">
        <p>Every delivery is a JSON object with a stable shape:</p>
        <DocCode>{`{
  "id": "uuid-of-this-delivery",
  "type": "monitor.threat.created",
  "createdAt": "2026-09-02T12:00:00.000Z",
  "data": { }
}`}</DocCode>
      </DocSection>

      <DocSection title="Event types">
        <DocList items={[
          "monitor.threat.created — monitored-wallet threat event",
          "correlation.appeared — a new observable correlation crossed your threshold",
          "correlation.increased — a persisted correlation increased meaningfully",
          "correlation.decreased — a persisted correlation left the strong band",
          "correlation.disappeared — a persisted correlation is no longer present"
        ]} />
      </DocSection>

      <DocSection title="Delivery headers">
        <DocCode>{`aegix-webhook-id: <your webhook AEGIX id>
aegix-event-id: evt_01...
aegix-timestamp: 1720000000
aegix-signature: <hex HMAC-SHA256>`}</DocCode>
      </DocSection>

      <DocSection title="Signature scheme">
        <p>Verify the signature against the exact raw body bytes:</p>
        <DocCode>{`signature = hex( HMAC-SHA256( secret, "<aegix-timestamp>.<rawBody>" ) )`}</DocCode>
        <p className="mt-3">Always use the raw request body exactly as received — never re-serialize it. See the signature and verification pages for the reference implementation.</p>
      </DocSection>
    </div>
  );
}
