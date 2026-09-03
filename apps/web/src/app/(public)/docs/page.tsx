import Link from "next/link";
import { DocHeading, DocSection, DocList } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation",
  description: "AEGIX documentation — product, intelligence, methodology, developer API, webhooks, and security."
};

export default function DocsIndexPage() {
  return (
    <div>
      <DocHeading eyebrow="Docs" title="AEGIX documentation" lead="Everything you need to understand and integrate AEGIX." />

      <section className="grid gap-4 md:grid-cols-2">
        {[
          { href: "/docs/quick-start", title: "Quick Start", body: "Analyze a wallet end-to-end in a few steps." },
          { href: "/docs/authentication", title: "Wallet Authentication", body: "Sign a challenge with your Solana wallet. No transaction, no SOL." },
          { href: "/docs/wallet-x-ray", title: "Wallet X-Ray", body: "Privacy exposure score, dimensions, evidence, and attack paths." },
          { href: "/docs/compare", title: "Compare Wallets", body: "Cross-wallet correlation, confidence, and population commonality." },
          { href: "/docs/monitor", title: "Privacy Monitor", body: "Track exposure changes and receive alerts." },
          { href: "/docs/api/overview", title: "Developer API", body: "Scoped keys, metered quota, usage reporting, and signed webhooks." }
        ].map((c) => (
          <Link key={c.href} href={c.href} className="card-surface block p-5 transition hover:border-accent/40">
            <h3 className="font-display text-lg font-semibold text-marble">{c.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
          </Link>
        ))}
      </section>

      <DocSection title="Guiding principle">
        <p>
          AEGIX reports observable linkability, never asserted identity. Correlation is not ownership, and the
          AEGIX observed population is not the global Solana population. Every surface keeps these distinctions explicit.
        </p>
      </DocSection>
    </div>
  );
}
