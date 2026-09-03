import { DocHeading, DocSection, DocCode } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Quotas" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Quotas" lead="Metered usage that resets each period." />
      <DocSection title="Check your usage">
        <DocCode>{`GET /v1/developer/usage
Authorization: Bearer aegix_live_...`}</DocCode>
        <p className="mt-3">Returns the period start/end, used, limit, remaining, reset time, and a per-operation breakdown.</p>
      </DocSection>
      <DocSection title="Exhaustion">
        <p>When quota is exhausted, requests return <code className="font-mono">429 QUOTA_EXCEEDED</code> with reset information. Keys do not multiply quota.</p>
      </DocSection>
    </div>
  );
}
