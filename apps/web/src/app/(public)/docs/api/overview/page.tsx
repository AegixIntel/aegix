import Link from "next/link";
import { DocHeading, DocSection, DocList, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Developer API Overview" };

export default function ApiOverviewDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Developer API" title="Overview" lead="Integrate AEGIX intelligence into your own tooling." />

      <DocSection title="Base URL">
        <DocCode>{`https://aegixintelligence.com/api/v1/developer`}</DocCode>
      </DocSection>

      <DocSection title="Authentication">
        <p>Authenticate with a scoped API key in the <code className="font-mono">Authorization</code> header. Keys are shown once at creation and are never retrievable again.</p>
        <DocCode>{`Authorization: Bearer aegix_live_<base58>`}</DocCode>
        <p className="mt-3">
          <Link href="/docs/api/authentication" className="text-accent underline">Read authentication →</Link>
        </p>
      </DocSection>

      <DocSection title="Endpoints">
        <DocList items={[
          "POST /v1/developer/intelligence/wallet — analyze a wallet",
          "GET /v1/developer/intelligence/analysis/:id — poll analysis result",
          "POST /v1/developer/intelligence/compare — compare two wallets",
          "GET /v1/developer/intelligence/comparison/:pairId — get cached comparison",
          "GET /v1/developer/status — key + scope status",
          "GET /v1/developer/usage — metered quota usage"
        ]} />
      </DocSection>

      <DocSection title="Example request">
        <DocCode>{`curl -X POST https://aegixintelligence.com/api/v1/developer/intelligence/compare \\
  -H "Authorization: Bearer aegix_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"walletA":"<ADDR_A>","walletB":"<ADDR_B>"}'`}</DocCode>
      </DocSection>

      <DocNote>
        API keys are scoped per permission and subject to a metered quota and rate limits. Quota and rate limits are separate concepts.
      </DocNote>
    </div>
  );
}
