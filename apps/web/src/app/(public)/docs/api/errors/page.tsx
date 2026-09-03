import { DocHeading, DocSection, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Errors" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Errors" lead="Structured error codes and a safe error envelope." />
      <DocSection title="Error shape">
        <DocCode>{`{
  "error": { "code": "INVALID_WALLET", "message": "..." },
  "meta": { "requestId": "..." }
}`}</DocCode>
      </DocSection>
      <DocSection title="Common codes">
        <p>INVALID_WALLET · DUPLICATE_WALLET · FEATURE_DISABLED · ACCOUNT_NOT_COMPARABLE · RPC_UNAVAILABLE · COMPARISON_IN_PROGRESS · QUOTA_EXCEEDED · ANALYSIS_REQUIRED · SERVICE_BUSY.</p>
      </DocSection>
      <DocNote>
        Production error responses never expose stack traces, SQL, internal hostnames, or secret values. Details go to server logs only.
      </DocNote>
    </div>
  );
}
