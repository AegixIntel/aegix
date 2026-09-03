import { DocHeading, DocSection, DocCode } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Webhook Signatures" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Webhooks" title="Signatures" lead="Every delivery is signed so you can verify authenticity." />
      <DocSection title="Headers">
        <DocCode>{`aegix-webhook-id
aegix-event-id
aegix-timestamp
aegix-signature`}</DocCode>
      </DocSection>
      <DocSection title="Signature scheme">
        <DocCode>{`signature = hex( HMAC-SHA256( secret, "<aegix-timestamp>.<rawBody>" ) )`}</DocCode>
        <p className="mt-3">Always verify against the exact raw body bytes. See the verification page for the reference implementation.</p>
      </DocSection>
      <DocSection title="Secret handling">
        <p>Webhook secrets are shown once at creation/rotation and encrypted at rest. Rotating a secret invalidates the old one immediately.</p>
      </DocSection>
    </div>
  );
}
