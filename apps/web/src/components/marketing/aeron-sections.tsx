import Image from "next/image";
import Link from "next/link";
import { SectionLabel, StatusBadge, InlineArrowLink, CodePreview } from "@/components/ui/primitives";
import LiveStatsPanel from "@/components/live-stats-panel";
import { Reveal } from "@/components/motion/reveal";
import { InteractiveSystemMap } from "@/components/marketing/system-map";

/** Visual panel used as a restrained banner inside a section.
 *  `size="md"` constrains the panel width (centered) for smaller images. */
function VisualPanel({
  src,
  alt,
  caption,
  size = "full"
}: {
  src: string;
  alt: string;
  caption: string;
  size?: "full" | "md";
}) {
  return (
    <div className={size === "md" ? "mx-auto mt-10 max-w-2xl" : "mt-10"}>
      <div className="aspect-video overflow-hidden rounded-lg border border-white/10">
        <Image
          src={src}
          alt={alt}
          width={1280}
          height={720}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </div>
      <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">{caption}</p>
    </div>
  );
}

/* Category strip above hero — product names with status. */
export function CategoryStrip() {
  const items = [
    { label: "Privacy Intelligence", status: "LIVE" },
    { label: "Market Intelligence", status: "IN DEVELOPMENT" },
    { label: "AI Copilot", status: "PLANNED" },
    { label: "Intelligence Network", status: "RESEARCH" }
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-white/10 px-4 py-3 lg:px-8">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">{it.label}</span>
          <StatusBadge label={it.status} />
        </span>
      ))}
    </div>
  );
}

/* Hero — statement left, live stats mini-panel right. Staggered reveal. */
export function HeroStatement() {
  return (
    <section className="border-b border-white/10">
      <div className="grid gap-10 px-4 py-16 md:py-24 lg:grid-cols-[1.3fr_1fr] lg:px-8">
        <div>
          <Reveal as="p" className="section-label-accent">Financial &amp; On-Chain Intelligence</Reveal>
          <Reveal as="h1" delay={80} className="mt-6 statement-lg">
            See what
            <br />
            others don&apos;t.
          </Reveal>
          <Reveal delay={160} className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
            AEGIX transforms public on-chain and financial data into relationships, patterns, signals and
            intelligence.
          </Reveal>
          <Reveal delay={220} as="p" className="mt-2 text-sm text-muted-2">Starting with privacy intelligence on Solana.</Reveal>
          <Reveal delay={280} className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href="/app/analyze" className="btn-primary">
              Launch AEGIX <span className="btn-arrow text-white/70">→</span>
            </Link>
            <Link href="/methodology" className="btn-secondary">
              Explore the intelligence layer
            </Link>
          </Reveal>
        </div>
        <Reveal delay={200} className="flex items-start lg:pt-2">
          <LiveStatsPanel />
        </Reveal>
      </div>
    </section>
  );
}

/* System map — interactive AEGIX intelligence pipeline. */
export function SystemMap() {
  return <InteractiveSystemMap />;
}

/* How it works — numbered. */
export function HowItWorks() {
  const steps = [
    { n: "01", t: "Analyze a wallet", b: "Enter a Solana address. AEGIX fetches public activity and normalizes it." },
    { n: "02", t: "Read the evidence", b: "See exposure, dimensions, signals and verifiable evidence — not guesses." },
    { n: "03", t: "Monitor the change", b: "Track exposure over time and get alerted to meaningful changes." }
  ];
  return (
    <section className="border-b border-white/10">
      <div className="px-4 py-16 md:py-24 lg:px-8">
        <div className="max-w-2xl">
          <Reveal as="div"><SectionLabel>How it works</SectionLabel></Reveal>
          <Reveal as="h2" delay={60} className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            From on-chain activity to exposure.
          </Reveal>
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {steps.map((s, i) => (
            <Reveal key={s.n} as="div" delay={i * 120} className="border-t border-white/10 pt-6">
              <span className="font-mono text-sm text-muted-2">{s.n}</span>
              <h3 className="mt-3 font-display text-xl font-semibold text-marble">{s.t}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{s.b}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* Product line — rows with category + status + link. */
const PRODUCTS = [
  { cat: "Wallet X-Ray", status: "LIVE", name: "Wallet X-Ray", body: "Understand what your public wallet activity may reveal.", href: "/app/analyze", link: "analyze.aegix.app →" },
  { cat: "Attack My Wallet", status: "LIVE", name: "Attack My Wallet", body: "Follow observable paths through your on-chain activity.", href: "/app/attack", link: "attack.aegix.app →" },
  { cat: "Compare", status: "LIVE", name: "Compare Wallets", body: "Two wallets. One relationship model. Strength vs confidence.", href: "/app/compare", link: "compare.aegix.app →" },
  { cat: "Monitor", status: "LIVE", name: "Privacy Monitor", body: "Exposure changes. AEGIX notices.", href: "/app/monitors", link: "monitor.aegix.app →" },
  { cat: "Developer", status: "LIVE", name: "Developer Intelligence API", body: "Scoped keys, metered quota, usage reporting, signed webhooks.", href: "/developers", link: "developers.aegix.app →" },
  { cat: "Market Intelligence", status: "IN DEVELOPMENT", name: "Market Intelligence", body: "Narrative radar, anomaly detection, cross-market signal engine.", href: "/markets", link: "Explore the roadmap →" }
];

export function ProductLine() {
  return (
    <section className="border-b border-white/10">
      <div className="px-4 py-16 md:py-24 lg:px-8">
        <div className="max-w-2xl">
          <Reveal as="div"><SectionLabel>Product Line</SectionLabel></Reveal>
          <Reveal as="h2" delay={60} className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            The rails, end to end.
          </Reveal>
          <Reveal delay={120} className="mt-6 editorial-body">
            One loop: analyze on-chain activity, surface intelligence, monitor change.
          </Reveal>
        </div>
        <div className="mt-12 border-t border-white/10">
          {PRODUCTS.map((p, i) => (
            <Reveal key={p.name} as="div" delay={i * 90}>
              <Link href={p.href} className="group grid gap-4 border-b border-white/10 py-6 transition hover:border-white/25 md:grid-cols-[16rem_1fr_auto] md:items-baseline">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2">{p.cat}</span>
                  <StatusBadge label={p.status} />
                </div>
                <div>
                  <h3 className="font-display text-xl font-semibold text-marble">{p.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{p.body}</p>
                </div>
                <span className="font-mono text-xs text-muted-2 transition group-hover:text-accent-bright">{p.link}</span>
              </Link>
            </Reveal>
          ))}
        </div>
        <VisualPanel
          size="md"
          src="/assets/aegix-wallet-intelligence.jpg"
          alt="AEGIX Wallet Intelligence interface showing a privacy exposure score, evidence breakdown, and linked entities"
          caption="Privacy Intelligence · Wallet X-Ray" 
        />
      </div>
    </section>
  );
}

/* Developer infra — code-like preview. */
export function DeveloperInfra() {
  return (
    <section className="border-b border-white/10">
      <div className="grid gap-12 px-4 py-16 md:py-24 lg:grid-cols-2 lg:px-8">
        <div>
          <Reveal as="div"><SectionLabel>Developers</SectionLabel></Reveal>
          <Reveal as="h2" delay={60} className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            Intelligence is infrastructure.
          </Reveal>
          <Reveal delay={120} className="mt-6 editorial-body">
            Applications can consume AEGIX intelligence programmatically — scoped keys, metered quota, usage
            reporting, and signed webhooks.
          </Reveal>
          <Reveal delay={180} className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/developers" className="btn-primary">Open developer platform</Link>
            <Link href="/docs" className="btn-secondary">Read the docs</Link>
          </Reveal>
        </div>
        <Reveal delay={140} className="relative">
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
        </Reveal>
      </div>
      <div className="px-4 lg:px-8">
        <VisualPanel
          size="md"
          src="/assets/aegix-intelligence-infrastructure.jpg"
          alt="AEGIX intelligence infrastructure — servers and API layers"
          caption="Developers · Intelligence Is Infrastructure"
        />
      </div>
    </section>
  );
}

/* Epistemic principle. */
export function Epistemic() {
  return (
    <section className="border-b border-white/10 bg-white/[0.015]">
      <div className="px-4 py-20 text-center md:py-28 lg:px-8">
        <Reveal as="h2" className="statement mx-auto max-w-3xl">
          Correlation is not identity.
        </Reveal>
        <Reveal delay={120} className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
          AEGIX reports observable relationships, evidence and confidence. It does not turn correlation into
          unsupported claims about real-world ownership.
        </Reveal>
      </div>
    </section>
  );
}

/* Network / Solana + roadmap teaser. */
export function NetworkAndRoadmap() {
  return (
    <section className="border-b border-white/10">
      <div className="px-4 py-16 md:py-24 lg:px-8">
        <div className="grid gap-12 md:grid-cols-2">
          <div>
            <Reveal as="div"><SectionLabel>Network</SectionLabel></Reveal>
            <Reveal as="h2" delay={60} className="mt-6 font-display text-2xl font-semibold text-marble md:text-4xl">
              Built for the real-time on-chain economy.
            </Reveal>
            <Reveal delay={120} as="p" className="mt-4 text-muted-foreground">AEGIX starts on Solana.</Reveal>
          </div>
          <div>
            <Reveal as="div"><SectionLabel>Roadmap</SectionLabel></Reveal>
            <Reveal delay={80} className="mt-6 flex flex-wrap gap-2">
              <StatusBadge label="SHIPPED" />
              <StatusBadge label="CURRENT" />
              <StatusBadge label="NEXT" />
              <StatusBadge label="LATER" />
            </Reveal>
            <Reveal delay={140} as="p" className="mt-4 text-sm text-muted-foreground">
              Status-driven, not date-driven. See what&apos;s shipped, in development, and planned.{" "}
              <InlineArrowLink href="/roadmap">Explore the roadmap</InlineArrowLink>
            </Reveal>
          </div>
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          <Reveal delay={120}>
            <VisualPanel
              src="/assets/aegix-market-structure.jpg"
              alt="AEGIX market structure concept — aspirational research direction, in development"
              caption="Future · Market Intelligence (IN DEVELOPMENT)"
            />
          </Reveal>
          <Reveal delay={220}>
            <VisualPanel
              src="/assets/aegix-ecosystem-vision.jpg"
              alt="AEGIX ecosystem vision — aspirational future direction"
              caption="Vision · AEGIX Ecosystem"
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* Final CTA. */
export function FinalCta() {
  return (
    <section className="px-4 py-24 text-center md:py-32 lg:px-8">
      <Reveal as="h2" className="statement-lg">See what others don&apos;t.</Reveal>
      <Reveal delay={100} className="mx-auto mt-8 max-w-md text-lg text-muted-foreground">Start with your wallet.</Reveal>
      <Reveal delay={180} className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
        <Link href="/app/analyze" className="btn-primary">Launch AEGIX <span className="btn-arrow text-white/70">→</span></Link>
        <Link href="/docs" className="btn-secondary">Read the docs</Link>
      </Reveal>
    </section>
  );
}
