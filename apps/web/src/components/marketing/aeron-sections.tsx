import Image from "next/image";
import Link from "next/link";
import { SectionLabel, StatusBadge, InlineArrowLink, CodePreview } from "@/components/ui/primitives";
import LiveStatsPanel from "@/components/live-stats-panel";

/** Wide visual panel used as a restrained banner inside a section. */
function VisualPanel({
  src,
  alt,
  caption
}: {
  src: string;
  alt: string;
  caption: string;
}) {
  return (
    <div className="mt-10">
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
      <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">{caption}</p>
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

/* Hero — statement left, live stats mini-panel right. */
export function HeroStatement() {
  return (
    <section className="border-b border-white/10">
      <div className="grid gap-10 px-4 py-16 md:py-24 lg:grid-cols-[1.3fr_1fr] lg:px-8">
        <div>
          <p className="section-label-accent">Financial &amp; On-Chain Intelligence</p>
          <h1 className="mt-6 statement-lg">
            See what
            <br />
            others don&apos;t.
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
            AEGIX transforms public on-chain and financial data into relationships, patterns, signals and
            intelligence.
          </p>
          <p className="mt-2 text-sm text-muted-2">Starting with privacy intelligence on Solana.</p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href="/app/analyze" className="btn-primary">
              Launch AEGIX <span className="text-white/70">→</span>
            </Link>
            <Link href="/methodology" className="btn-secondary">
              Explore the intelligence layer
            </Link>
          </div>
        </div>
        <div className="flex items-start lg:pt-2">
          <LiveStatsPanel />
        </div>
      </div>
    </section>
  );
}

/* System map — AEGIX pipeline with boxed labels. */
export function SystemMap() {
  const stages = [
    { label: "Public Activity", kind: "surface" },
    { label: "Normalization", kind: "process" },
    { label: "Signals", kind: "process" },
    { label: "Relationships", kind: "process" },
    { label: "Correlation", kind: "process" },
    { label: "Confidence", kind: "meter" },
    { label: "Exposure", kind: "result" }
  ];
  return (
    <section className="border-b border-white/10">
      <div className="px-4 py-16 md:py-24 lg:px-8">
        <div className="max-w-2xl">
          <SectionLabel>AEGIX System Map</SectionLabel>
          <h2 className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            Public activity becomes observable intelligence.
          </h2>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-7">
          {stages.map((s) => (
            <div key={s.label} className="bg-ink-deep p-4">
              <span className="mono-label text-muted-2">{s.kind}</span>
              <p className="mt-2 font-mono text-sm text-marble/90">{s.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
          agent → activity → normalize → signal → correlate → confidence → exposure
        </p>
      </div>
    </section>
  );
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
          <SectionLabel>How it works</SectionLabel>
          <h2 className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            From on-chain activity to exposure.
          </h2>
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="border-t border-white/10 pt-6">
              <span className="font-mono text-sm text-muted-2">{s.n}</span>
              <h3 className="mt-3 font-display text-xl font-semibold text-marble">{s.t}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{s.b}</p>
            </div>
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
          <SectionLabel>Product Line</SectionLabel>
          <h2 className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            The rails, end to end.
          </h2>
          <p className="mt-6 editorial-body">
            One loop: analyze on-chain activity, surface intelligence, monitor change.
          </p>
        </div>
        <div className="mt-12 border-t border-white/10">
          {PRODUCTS.map((p) => (
            <Link key={p.name} href={p.href} className="group grid gap-4 border-b border-white/10 py-6 md:grid-cols-[16rem_1fr_auto] md:items-baseline">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2">{p.cat}</span>
                <StatusBadge label={p.status} />
              </div>
              <div>
                <h3 className="font-display text-xl font-semibold text-marble">{p.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{p.body}</p>
              </div>
              <span className="font-mono text-xs text-muted-2 group-hover:text-accent-bright">{p.link}</span>
            </Link>
          ))}
        </div>
        <VisualPanel
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
          <SectionLabel>Developers</SectionLabel>
          <h2 className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            Intelligence is infrastructure.
          </h2>
          <p className="mt-6 editorial-body">
            Applications can consume AEGIX intelligence programmatically — scoped keys, metered quota, usage
            reporting, and signed webhooks.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/developers" className="btn-primary">Open developer platform</Link>
            <Link href="/docs" className="btn-secondary">Read the docs</Link>
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
      <div className="px-4 lg:px-8">
        <VisualPanel
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
        <h2 className="statement mx-auto max-w-3xl">
          Correlation is not identity.
        </h2>
        <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
          AEGIX reports observable relationships, evidence and confidence. It does not turn correlation into
          unsupported claims about real-world ownership.
        </p>
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
            <SectionLabel>Network</SectionLabel>
            <h2 className="mt-6 font-display text-2xl font-semibold text-marble md:text-4xl">
              Built for the real-time on-chain economy.
            </h2>
            <p className="mt-4 text-muted-foreground">AEGIX starts on Solana.</p>
          </div>
          <div>
            <SectionLabel>Roadmap</SectionLabel>
            <div className="mt-6 flex flex-wrap gap-2">
              <StatusBadge label="SHIPPED" />
              <StatusBadge label="CURRENT" />
              <StatusBadge label="NEXT" />
              <StatusBadge label="LATER" />
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Status-driven, not date-driven. See what&apos;s shipped, in development, and planned.{" "}
              <InlineArrowLink href="/roadmap">Explore the roadmap</InlineArrowLink>
            </p>
          </div>
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          <VisualPanel
            src="/assets/aegix-market-structure.jpg"
            alt="AEGIX market structure concept — aspirational research direction, in development"
            caption="Future · Market Intelligence (IN DEVELOPMENT)"
          />
          <VisualPanel
            src="/assets/aegix-ecosystem-vision.jpg"
            alt="AEGIX ecosystem vision — aspirational future direction"
            caption="Vision · AEGIX Ecosystem"
          />
        </div>
      </div>
    </section>
  );
}

/* Final CTA. */
export function FinalCta() {
  return (
    <section className="px-4 py-24 text-center md:py-32 lg:px-8">
      <h2 className="statement-lg">See what others don&apos;t.</h2>
      <p className="mx-auto mt-8 max-w-md text-lg text-muted-foreground">Start with your wallet.</p>
      <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
        <Link href="/app/analyze" className="btn-primary">Launch AEGIX <span className="text-white/70">→</span></Link>
        <Link href="/docs" className="btn-secondary">Read the docs</Link>
      </div>
    </section>
  );
}
