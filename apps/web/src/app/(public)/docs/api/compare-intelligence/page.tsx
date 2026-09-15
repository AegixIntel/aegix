import { DocHeading, DocSection, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Compare Intelligence API" };

export default function ApiCompareDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Compare Intelligence" lead="Compare two wallets and read cross-wallet correlation." />

      <DocSection title="POST /v1/developer/intelligence/compare">
        <DocCode>{`curl -X POST https://aegixintelligence.com/api/v1/developer/intelligence/compare \\
  -H "Authorization: Bearer aegix_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"walletA":"<ADDR_A>","walletB":"<ADDR_B>"}'`}</DocCode>
      </DocSection>

      <DocSection title="GET /v1/developer/intelligence/comparison/:pairId">
        <p>Fetch a cached comparison by its canonical pair id. The pair identity is symmetric — <code className="font-mono">(A,B)</code> and <code className="font-mono">(B,A)</code> map to the same result.</p>
        <DocCode>{`curl https://aegixintelligence.com/api/v1/developer/intelligence/comparison/<pairId> \\
  -H "Authorization: Bearer aegix_live_..."`}</DocCode>
      </DocSection>

      <DocSection title="Response shape">
        <p>The comparison result exposes correlation strength and confidence separately, evidence families, relationship paths, clusters, population commonality, and limitations.</p>
      </DocSection>

      <DocNote>
        Correlation is observable linkability, never proof of ownership or identity.
      </DocNote>
    </div>
  );
}
