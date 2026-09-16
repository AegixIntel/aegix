import Link from "next/link";
import { SectionLabel, EditorialHeading, StatusBadge, FeatureRow, TechnicalMetric, ProductStatus } from "@/components/ui/primitives";
import { statusGroups } from "@/lib/site";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Intelligence",
  description: "AEGIX privacy intelligence — Wallet X-Ray, Attack My Wallet, Compare and Privacy Monitor on Solana."
};

export default function PrivacyPage() {
  return (
    <div className="pb-24">
      <div className="container-page py-20 md:py-28">
        <div className="max-w-3xl">
          <SectionLabel status="LIVE">Privacy Intelligence</SectionLabel>
          <EditorialHeading as="h1" className="mt-6">
            See your wallet from the outside.
          </EditorialHeading>
          <p className="mt-6 editorial-body">
            Understand what public on-chain activity can reveal — before someone else does. AEGIX surfaces the
            observable linkability of a wallet, with evidence, confidence and limitations made explicit.
          </p>
        </div>

        <div className="mt-14">
          <ProductStatus groups={statusGroups("PRIVACY_PAGE")} />
        </div>
      </div>

      <div className="container-page">
        <FeatureRow
          index="01"
          title="Wallet X-Ray"
          body="An evidence-based privacy exposure report for a single wallet."
          detail={["Privacy Exposure Score", "7 Dimensions", "Evidence", "Confidence"]}
          href="/app/analyze"
          cta="Analyze a wallet"
        />
        <section id="attack" className="scroll-mt-16">
          <FeatureRow
            index="02"
            title="Attack My Wallet"
            body="Simulated paths an observer could follow through public data."
            detail={["Relationship Graph", "Funding Paths", "Entity Exposure", "Linkability Signals"]}
            href="/app/analyze"
            cta="Attack My Wallet"
          />
        </section>
        <FeatureRow
          index="03"
          title="Compare Wallets"
          body="Cross-wallet correlation with strength and confidence reported separately."
          detail={["Funding", "Counterparties", "Entities", "Behavior", "Temporal Correlation"]}
          href="/app/compare"
          cta="Compare Wallets"
        />
        <FeatureRow
          index="04"
          title="Privacy Monitor"
          body="Track exposure changes and receive alerts."
          detail={["Exposure Diff", "Correlation Alerts", "Threat Events"]}
          href="/app/monitors"
          cta="Start Monitoring"
        />
      </div>

      <div className="container-page mt-20 border-t border-white/10 pt-16">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <TechnicalMetric label="Exposure Scale" value="0–100" />
            <p className="mt-3 text-sm text-muted-foreground">Composite privacy exposure, per dimension.</p>
          </div>
          <div>
            <TechnicalMetric label="Confidence" value="0.00–1.00" />
            <p className="mt-3 text-sm text-muted-foreground">How reliable the underlying evidence is.</p>
          </div>
          <div>
            <TechnicalMetric label="Dimensions" value="7" />
            <p className="mt-3 text-sm text-muted-foreground">Linkability, funding, entities, clusters, behavior, counterparties, patterns.</p>
          </div>
        </div>
      </div>

      <div className="container-page mt-16">
        <p className="max-w-2xl text-sm text-muted-2">
          AEGIX reports observable linkability. Correlation is not proof of ownership, and the AEGIX observed
          population is not the global Solana population.{" "}
          <Link href="/methodology" className="text-marble underline underline-offset-4">
            Read the methodology →
          </Link>
        </p>
      </div>
    </div>
  );
}
