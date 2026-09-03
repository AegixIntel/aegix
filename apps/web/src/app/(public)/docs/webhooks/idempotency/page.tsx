import { DocHeading, DocSection, DocList } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Webhook Idempotency" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Webhooks" title="Idempotency" lead="Handle duplicate deliveries safely." />
      <DocSection title="Event id">
        <p>The <code className="font-mono">data.id</code> (or <code className="font-mono">aegix-event-id</code> header) identifies one logical event. Store processed event ids and ignore duplicates — AEGIX retries deliveries, so the same event id may arrive more than once.</p>
      </DocSection>
      <DocSection title="Guidance">
        <DocList items={[
          "Persist processed event ids and skip known ones.",
          "Make handlers idempotent regardless of event id.",
          "Never log the full signature or your secret."
        ]} />
      </DocSection>
    </div>
  );
}
