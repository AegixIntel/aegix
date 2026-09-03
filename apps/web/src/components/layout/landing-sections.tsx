import Image from "next/image";
import Link from "next/link";
import {
  SectionLabel,
  EditorialHeading,
  StatusBadge,
  FeatureRow,
  InlineArrowLink,
  TechnicalMetric,
  CodePreview,
  PipelineDiagram,
  ProductStatus
} from "@/components/ui/primitives";

/* ------------------------------------------------------------------ */
/* HERO — statement dominant, restrained visual below.                */
/* ------------------------------------------------------------------ */
export function HeroSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-wide py-20 md:py-32">
        <div className="max-w-4xl">
          <p className="section-label-accent">Financial &amp; On-Chain Intelligence</p>
          <h1 className="mt-6 statement-lg">
            See what
            <br />
            others don&apos;t.
          </h1>
          <p className="mt-8 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            AEGIX transforms public on-chain and financial data into relationships, patterns, signals and
            intelligence.
          </p>
          <p className="mt-2 text-sm text-muted-2">Starting with privacy intelligence on Solana.</p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href="/app/analyze" className="btn-primary">
              Launch AEGIX <span className="text-white/70">→</span>
            </Link>
            <Link href="/intelligence" className="btn-secondary">
              Explore the intelligence layer
            </Link>
          </div>
        </div>

        <div className="mt-16 md:mt-20">
          <div className="aspect-video overflow-hidden rounded-lg border border-white/10">
            <Image
              src="/assets/aegix-wallet-intelligence.jpg"
              alt="AEGIX Wallet Intelligence interface showing a privacy exposure score, evidence breakdown, and linked entities"
              width={1280}
              height={720}
              priority
              className="h-full w-full object-cover"
            />
          </div>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
            Wallet X-Ray · Privacy exposure on public data
          </p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* INTRODUCTION                                                       */
/* ------------------------------------------------------------------ */
export function IntroductionSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-narrow py-20 md:py-28">
        <SectionLabel>What AEGIX is</SectionLabel>
        <EditorialHeading className="mt-6">
          Information is everywhere.
          <br />
          Intelligence isn&apos;t.
        </EditorialHeading>
        <div className="mt-10 space-y-4 text-lg leading-relaxed text-muted-foreground">
          <p>
            Markets and blockchains generate enormous public datasets. AEGIX focuses on understanding the
            relationships and patterns inside them.
          </p>
          <p>
            The result is an intelligence layer: not raw data, not a dashboard, but structured insight with
            evidence, confidence and limitations made explicit.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* LIVE INTELLIGENCE — product rows                                   */
/* ------------------------------------------------------------------ */
export function LiveIntelligenceSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-page py-20 md:py-28">
        <div className="max-w-2xl">
          <SectionLabel status="LIVE">Live Intelligence</SectionLabel>
          <EditorialHeading className="mt-6">See your wallet from the outside.</EditorialHeading>
          <p className="mt-6 editorial-body">
            Privacy intelligence turns public wallet activity into an evidence-based exposure model — built
            from the ground up.
          </p>
        </div>

        <div className="mt-12">
          <ProductStatus
            live={["Wallet X-Ray", "Attack My Wallet", "Compare Wallets", "Privacy Monitor", "Developer Intelligence API"]}
            inDevelopment={["Market Intelligence"]}
          />
        </div>

        <div className="mt-14">
          <FeatureRow
            index="01"
            title="Wallet X-Ray"
            body="Understand what your public wallet activity may reveal."
            detail={["Privacy Exposure Score", "7 Exposure Dimensions", "Evidence", "Confidence"]}
            href="/privacy"
            cta="Explore Wallet X-Ray"
          />
          <FeatureRow
            index="02"
            title="Attack My Wallet"
            body="Follow observable paths through your on-chain activity."
            detail={["Relationship Graph", "Funding Paths", "Entity Exposure", "Linkability Signals"]}
            href="/app/attack"
            cta="Attack My Wallet"
          />
          <FeatureRow
            index="03"
            title="Compare Wallets"
            body="Two wallets. One relationship model."
            detail={["Funding", "Counterparties", "Entities", "Temporal Correlation"]}
            href="/app/compare"
            cta="Compare Wallets"
          />
          <FeatureRow
            index="04"
            title="Privacy Monitor"
            body="Exposure changes. AEGIX notices."
            detail={["Exposure Diff", "Correlation Alerts", "Threat Events", "Email + Webhooks"]}
            href="/app/monitors"
            cta="Start Monitoring"
          />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* INTELLIGENCE PRIMITIVES                                            */
/* ------------------------------------------------------------------ */
const PRIMITIVES = [
  { n: "01", key: "Funding", body: "Traces observable funding provenance while filtering dust and low-quality relationships." },
  { n: "02", key: "Counterparties", body: "Maps the wallets a target interacts with, weighted by how distinctive each is." },
  { n: "03", key: "Entities", body: "Binds activity to known entities (exchanges, protocols) from a verified registry." },
  { n: "04", key: "Behavior", body: "Compares behavioral fingerprints to detect resemblance between wallets." },
  { n: "05", key: "Temporal Activity", body: "Looks for meaningful co-occurrence in transaction timing." },
  { n: "06", key: "Relationships", body: "Builds a bounded graph of observable and inferred edges between wallets." },
  { n: "07", key: "Commonality", body: "Weights overlap against the AEGIX-observed population, not the whole network." }
];

export function PrimitivesSection() {
  return (
    <section id="intelligence" className="border-b border-white/10">
      <div className="container-wide py-20 md:py-28">
        <div className="max-w-2xl">
          <SectionLabel>Intelligence Primitives</SectionLabel>
          <EditorialHeading className="mt-6">Public activity becomes observable intelligence.</EditorialHeading>
          <p className="mt-6 editorial-body">
            Every AEGIX result is composed from a small set of deterministic primitives — each backed by a real
            engine, each traceable to evidence.
          </p>
        </div>

        <div className="mt-14 grid gap-x-12 gap-y-0 sm:grid-cols-2 lg:grid-cols-4">
          {PRIMITIVES.map((p) => (
            <div key={p.key} className="border-t border-white/10 py-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-muted-2">{p.n}</span>
                <h3 className="font-display text-lg font-semibold text-marble">{p.key}</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* SYSTEM PIPELINE                                                    */
/* ------------------------------------------------------------------ */
export function PipelineSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-page py-20 md:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionLabel>System Pipeline</SectionLabel>
            <EditorialHeading className="mt-6">How public activity becomes exposure.</EditorialHeading>
            <p className="mt-6 editorial-body">
              A deterministic, versioned pipeline. Each stage is inspectable and bounded — not a generator
              producing confident guesses.
            </p>
          </div>
          <div className="border border-white/10 p-8">
            <PipelineDiagram
              steps={["Public Activity", "Normalization", "Signals", "Relationships", "Correlation", "Confidence", "Exposure"]}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* EPISTEMIC PRINCIPLE — signature statement                          */
/* ------------------------------------------------------------------ */
export function EpistemicSection() {
  return (
    <section className="border-b border-white/10 bg-white/[0.015]">
      <div className="container-narrow py-24 text-center md:py-32">
        <div className="mx-auto max-w-3xl">
          <p className="section-label">A Core Principle</p>
          <h2 className="mt-8 statement">
            Correlation
            <br />
            is not
            <br />
            identity.
          </h2>
          <p className="mx-auto mt-10 max-w-xl text-lg leading-relaxed text-muted-foreground">
            AEGIX reports observable relationships, evidence and confidence. It does not turn correlation into
            unsupported claims about real-world ownership.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* COMPARE — strength vs confidence                                   */
/* ------------------------------------------------------------------ */
export function CompareSection() {
  const families = ["Funding", "Counterparties", "Entities", "Behavior", "Protocol Sequences", "Temporal Correlation", "Population Commonality"];
  return (
    <section className="border-b border-white/10">
      <div className="container-page py-20 md:py-28">
        <div className="grid gap-12 lg:grid-cols-2">
          <div className="max-w-xl">
            <SectionLabel>Compare</SectionLabel>
            <EditorialHeading className="mt-6">Two wallets. One relationship model.</EditorialHeading>
            <p className="mt-6 editorial-body">
              Compare measures how much two wallets look alike, across evidence families — and how much you
              should trust that measurement.
            </p>
            <div className="mt-10 grid grid-cols-2 gap-6">
              <TechnicalMetric label="Strength" value="0.78" />
              <TechnicalMetric label="Confidence" value="0.82" />
            </div>
            <p className="mt-4 text-xs text-muted-2">
              Strength answers &quot;how strong are the signals?&quot; Confidence answers &quot;how reliable is
              the evidence?&quot; They are never conflated.
            </p>
            <div className="mt-8">
              <InlineArrowLink href="/app/compare">Open Compare</InlineArrowLink>
            </div>
          </div>

          <div className="border border-white/10 p-8">
            <p className="mono-label">Evidence Families</p>
            <ul className="mt-4 divide-y divide-white/10">
              {families.map((f) => (
                <li key={f} className="flex items-center justify-between py-3 text-sm text-muted-foreground">
                  <span>{f}</span>
                  <span className="font-mono text-xs text-muted-2">observed</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* MONITORING                                                         */
/* ------------------------------------------------------------------ */
export function MonitoringSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-page py-20 md:py-28">
        <div className="max-w-2xl">
          <SectionLabel>Privacy Monitor</SectionLabel>
          <EditorialHeading className="mt-6">Exposure changes. AEGIX notices.</EditorialHeading>
          <p className="mt-6 editorial-body">
            Continuous privacy monitoring re-analyzes a wallet, computes an exposure diff, and alerts you to
            meaningful change.
          </p>
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {[
            { t: "Exposure Diff", b: "Baseline vs latest exposure, per dimension." },
            { t: "Correlation Alerts", b: "New or changed correlation evidence, deduped." },
            { t: "Threat Events", b: "In-app notifications, verified email, signed webhooks." }
          ].map((c) => (
            <div key={c.t} className="border-t border-white/10 pt-6">
              <h3 className="font-display text-lg font-semibold text-marble">{c.t}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{c.b}</p>
            </div>
          ))}
        </div>
        <div className="mt-10">
          <InlineArrowLink href="/app/monitors">Start Monitoring</InlineArrowLink>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* DEVELOPER INFRASTRUCTURE                                           */
/* ------------------------------------------------------------------ */
export function DeveloperSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-wide py-20 md:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <SectionLabel>Developers</SectionLabel>
            <EditorialHeading className="mt-6">Intelligence is infrastructure.</EditorialHeading>
            <p className="mt-6 editorial-body">
              Applications can consume AEGIX intelligence programmatically — scoped keys, metered quota, usage
              reporting, and signed webhooks.
            </p>
            <ul className="mt-8 space-y-2">
              {["Wallet Intelligence API", "Compare Intelligence API", "API Keys & Scopes", "Usage & Quotas", "Webhooks"].map((i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="h-1 w-1 rounded-full bg-accent-bright" aria-hidden="true" />
                  {i}
                </li>
              ))}
            </ul>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Link href="/developers" className="btn-primary">
                Open developer platform
              </Link>
              <Link href="/docs" className="btn-secondary">
                Read the docs
              </Link>
            </div>
          </div>

          <div>
            <CodePreview>{`POST /v1/developer/intelligence/wallet

Authorization: Bearer aegix_live_...

{
  "wallet": "<SOLANA_ADDRESS>"
}

→ analysisId
→ status
→ pollUrl`}</CodePreview>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
              Scoped · Metered · Signed webhooks
            </p>
          </div>
        </div>

        <div className="mt-16">
          <div className="aspect-video overflow-hidden rounded-lg border border-white/10">
            <Image
              src="/assets/aegix-intelligence-infrastructure.jpg"
              alt="AEGIX intelligence infrastructure — servers and API layers"
              width={1280}
              height={720}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </div>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
            Intelligence Is Infrastructure
          </p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* MARKET INTELLIGENCE — IN DEVELOPMENT                               */
/* ------------------------------------------------------------------ */
export function MarketSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-page py-20 md:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <SectionLabel status="IN DEVELOPMENT">Market Intelligence</SectionLabel>
            <EditorialHeading className="mt-6">Markets beyond the surface.</EditorialHeading>
            <p className="mt-6 editorial-body">
              AEGIX is expanding into market intelligence — detecting narratives, anomalies, and emerging
              signals before they become consensus.
            </p>
            <ul className="mt-8 space-y-2">
              {["Narrative Radar", "Anomaly Detection", "Cross-Market Intelligence", "Signal Engine"].map((i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="h-1 w-1 rounded-full bg-muted-2" aria-hidden="true" />
                  {i}
                </li>
              ))}
            </ul>
            <div className="mt-10">
              <Link href="/roadmap" className="btn-secondary">
                Explore the roadmap
              </Link>
            </div>
          </div>

          <div>
            <div className="aspect-video overflow-hidden rounded-lg border border-white/10 opacity-80">
              <Image
                src="/assets/aegix-market-structure.jpg"
                alt="AEGIX market structure concept — aspirational research direction, in development"
                width={1280}
                height={720}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* HOW AEGIX THINKS + NETWORK + ROADMAP TEASER                        */
/* ------------------------------------------------------------------ */
export function HowSection() {
  return (
    <section className="border-b border-white/10">
      <div className="container-page py-20 md:py-28">
        <div className="max-w-2xl">
          <SectionLabel>How AEGIX Thinks</SectionLabel>
          <EditorialHeading className="mt-6">Structure, not decoration.</EditorialHeading>
          <p className="mt-6 editorial-body">
            Intelligence should communicate through structure, typography, evidence and hierarchy. AEGIX is
            built to clarify the on-chain world — not to decorate it.
          </p>
        </div>
        <div className="mt-10 grid gap-8 md:grid-cols-3">
          {[
            { t: "Evidence first", b: "Every claim traces to observable transaction data." },
            { t: "Confidence quantified", b: "Strength and confidence are reported separately." },
            { t: "Limitations exposed", b: "Counter-evidence and data-quality limits are shown, not hidden." }
          ].map((c) => (
            <div key={c.t} className="border-t border-white/10 pt-6">
              <h3 className="font-display text-lg font-semibold text-marble">{c.t}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{c.b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function NetworkSection() {
  return (
    <section id="network" className="border-b border-white/10">
      <div className="container-page py-20">
        <div className="max-w-2xl">
          <SectionLabel>Network</SectionLabel>
          <EditorialHeading className="mt-6">Built for the real-time on-chain economy.</EditorialHeading>
          <p className="mt-6 editorial-body">
            AEGIX starts on Solana — a network with the throughput and low cost to surface real-time
            relationships across public activity.
          </p>
        </div>
      </div>
    </section>
  );
}

export function RoadmapTeaserSection() {
  const groups = [
    { label: "Shipped", items: ["Intelligence Core", "Wallet X-Ray", "Attack My Wallet", "Compare Intelligence", "Privacy Monitor", "Developer Intelligence API"], tone: "SHIPPED" },
    { label: "Current", items: ["Public Product Launch", "Multi-User Production", "Documentation", "Infrastructure Hardening"], tone: "CURRENT" },
    { label: "Next", items: ["Market Intelligence", "Narrative Radar", "Anomaly Detection", "Signal Engine"], tone: "NEXT" },
    { label: "Later", items: ["AI Intelligence Copilot", "Wallet Reputation", "Intelligence Network", "$AEX Economic Layer", "Multi-Chain"], tone: "LATER" }
  ] as const;
  return (
    <section className="border-b border-white/10">
      <div className="container-page py-20 md:py-24">
        <div className="max-w-2xl">
          <SectionLabel>Roadmap</SectionLabel>
          <EditorialHeading className="mt-6">Status-driven, not date-driven.</EditorialHeading>
          <p className="mt-6 editorial-body">
            AEGIX has shipped an intelligence core. What follows is built on the real repository state — not an
            aspirational timeline.
          </p>
        </div>
        <div className="mt-12 grid gap-x-12 gap-y-0 md:grid-cols-4">
          {groups.map((g) => (
            <div key={g.label} className="border-t border-white/10 py-6">
              <StatusBadge label={g.label} className="mb-4" />
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <li key={i} className="text-sm text-muted-foreground">
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10">
          <InlineArrowLink href="/roadmap">View the roadmap</InlineArrowLink>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* FINAL CTA                                                          */
/* ------------------------------------------------------------------ */
export function FinalCtaSection() {
  return (
    <section>
      <div className="container-narrow py-24 text-center md:py-32">
        <h2 className="statement-lg">See what others don&apos;t.</h2>
        <p className="mx-auto mt-8 max-w-md text-lg text-muted-foreground">Start with your wallet.</p>
        <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/app/analyze" className="btn-primary">
            Launch AEGIX <span className="text-white/70">→</span>
          </Link>
          <Link href="/docs" className="btn-secondary">
            Read the docs
          </Link>
        </div>
      </div>
    </section>
  );
}
