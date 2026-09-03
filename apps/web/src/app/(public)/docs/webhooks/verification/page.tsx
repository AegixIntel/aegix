import { DocHeading, DocSection, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Webhook Verification" };

export default function WebhookVerificationDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Webhooks" title="Verification" lead="Always verify the signature before acting on a delivery." />

      <DocSection title="Reference helper">
        <p>The canonical consumer implementation ships in <code className="font-mono">@aegix/webhook-delivery</code>:</p>
        <DocCode>{`import { verifyWebhookRequest } from "@aegix/webhook-delivery";

const result = verifyWebhookRequest({
  rawBody,                              // exact request body text
  signature: req.headers["aegix-signature"],
  timestamp:  req.headers["aegix-timestamp"],
  secret,                               // from the dashboard (shown once)
  toleranceSeconds: 300                 // 5 minutes clock skew
});

if (!result.valid) return res.status(401).end();`}</DocCode>
      </DocSection>

      <DocSection title="Hand-rolled example">
        <DocCode>{`import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, signature, timestamp, secret) {
  if (!signature || !timestamp) return false;
  const expected = createHmac("sha256", secret)
    .update(\`\${timestamp}.\${rawBody}\`, "utf8").digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!/^\\d{1,10}$/.test(timestamp) || skew > 300) return false;
  return timingSafeEqual(provided, expected);
}`}</DocCode>
      </DocSection>

      <DocSection title="Rules">
        <p>Use <code className="font-mono">crypto.timingSafeEqual</code> on decoded digests, and reject stale or future timestamps. AEGIX performs constant-time comparison and enforces timestamp freshness for replay protection.</p>
      </DocSection>

      <DocNote>
        Never do JSON.parse(body) → JSON.stringify(body) → verify. Serialization differences silently invalidate the signature.
      </DocNote>
    </div>
  );
}
