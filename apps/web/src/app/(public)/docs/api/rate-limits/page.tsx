import { DocHeading, DocSection, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Rate Limits" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Rate Limits" lead="Per-request throttling, separate from quota." />
      <DocSection title="Distinct concept">
        <p>Rate limits cap how rapidly you may make requests to prevent bursts. They are distinct from the metered quota, which caps total usage over a period.</p>
      </DocSection>
      <DocSection title="Behavior">
        <p>Exceeding a rate limit returns <code className="font-mono">429</code> with retry guidance. Respect backoff headers and do not retry in a tight loop.</p>
      </DocSection>
      <DocNote>
        Quota and rate limits are separate. Rate limits protect availability; quota enforces your plan.
      </DocNote>
    </div>
  );
}
