import Link from "next/link";
import { DocHeading, DocSection, DocList, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Quick Start" };

export default function QuickStartPage() {
  return (
    <div>
      <DocHeading eyebrow="Getting Started" title="Quick Start" lead="Analyze a Solana wallet and see its privacy exposure in a few steps." />
      <DocSection title="1. Analyze a wallet">
        <p>Open the Wallet X-Ray page and paste a Solana address. AEGIX will classify the account, and if it is a personal wallet, start an analysis.</p>
        <Link href="/app/analyze" className="inline-block text-sm text-accent-ink underline">Open Wallet X-Ray →</Link>
      </DocSection>
      <DocSection title="2. Wait for the analysis">
        <p>Analysis runs asynchronously. The UI polls the real backend status (queued → fetching → normalizing → analyzing → scoring → graphing → ready). AEGIX never fakes completion.</p>
      </DocSection>
      <DocSection title="3. Read the report">
        <p>The report shows the privacy exposure score, analysis confidence, seven exposure dimensions, top signals with evidence, and attack paths — with limitations and engine versions made explicit.</p>
      </DocSection>
      <DocSection title="4. Connect a wallet to save & monitor">
        <p>Connect a Solana wallet to save analyses and comparisons, create monitors, receive notifications, and manage developer API keys. Signing in costs no SOL.</p>
      </DocSection>

      <DocSection title="Try the API">
        <p>Developers can also request intelligence programmatically with a scoped API key.</p>
        <DocCode>{`curl -X POST https://aegixintelligence.com/api/v1/developer/intelligence/wallet \\
  -H "Authorization: Bearer aegix_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"wallet":"<SOLANA_ADDRESS>"}'`}</DocCode>
        <p className="mt-3">
          <Link href="/docs/api/overview" className="text-accent-ink underline">Read the Developer API →</Link>
        </p>
      </DocSection>

      <DocNote>
        AEGIX reports observable linkability — it never asserts identity. Correlation is not ownership, and the AEGIX observed population is not the global Solana population.
      </DocNote>
    </div>
  );
}
