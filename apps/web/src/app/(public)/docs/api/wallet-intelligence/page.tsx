import { DocHeading, DocSection, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Wallet Intelligence API" };

export default function ApiWalletDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Wallet Intelligence" lead="Request an analysis for a wallet, then poll for the result." />

      <DocSection title="POST /v1/developer/intelligence/wallet">
        <DocCode>{`curl -X POST https://aegixintelligence.com/api/v1/developer/intelligence/wallet \\
  -H "Authorization: Bearer aegix_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"wallet":"<SOLANA_ADDRESS>"}'`}</DocCode>
        <p className="mt-3">Returns <code className="font-mono">data.analysisId</code>, <code className="font-mono">status</code>, and <code className="font-mono">pollUrl</code>.</p>
      </DocSection>

      <DocSection title="GET /v1/developer/intelligence/analysis/:id">
        <DocCode>{`curl https://aegixintelligence.com/api/v1/developer/intelligence/analysis/<id> \\
  -H "Authorization: Bearer aegix_live_..."`}</DocCode>
        <p className="mt-3">Poll until the status is <code className="font-mono">READY</code>; the response carries the full wallet X-Ray payload (score, dimensions, signals, evidence, attack paths, engine versions).</p>
      </DocSection>

      <DocSection title="Errors">
        <p>Invalid addresses, non-eligible accounts, quota exhaustion, and service busy are returned as structured error codes.</p>
      </DocSection>

      <DocNote>
        The developer API never triggers uncontrolled work — requests are gated by validation, classification, and a bounded admission pipeline.
      </DocNote>
    </div>
  );
}
