import { DocHeading, DocSection, DocList, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy Monitor" };

export default function MonitorDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Product" title="Privacy Monitor" lead="Track how a wallet's privacy exposure changes over time." />

      <DocSection title="What it does">
        <DocList items={[
          "Continuously re-analyzes a monitored wallet on a schedule.",
          "Computes an exposure diff against the baseline.",
          "Fires a threat event when a meaningful change is detected.",
          "Creates in-app notifications, and optionally email alerts.",
          "Delivers signed webhooks to your endpoint (developer surface)."
        ]} />
      </DocSection>

      <DocSection title="Alert rules">
        <p>Configure minimum severity, minimum confidence, score-delta threshold, cooldown, and which event types trigger a notification. AEGIX exposes only supported rule configuration — there is no arbitrary rule language.</p>
      </DocSection>

      <DocSection title="Notifications">
        <p>Notifications are delivered in-app, and optionally to a verified notification email. The email is a delivery destination only — it is not a login credential. Webhook configuration lives in the developer portal, not in the normal user monitor flow.</p>
      </DocSection>

      <DocNote>
        AEGIX never presents a fabricated or invented change. Only persisted real analyses are shown, and states are distinguished as observed or inferred.
      </DocNote>
    </div>
  );
}
