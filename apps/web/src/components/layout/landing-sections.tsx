import Image from "next/image";
import Link from "next/link";

function SectionHeading({
  eyebrow,
  title,
  lead,
  id
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  id?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="marketing-eyebrow">{eyebrow}</p>
      <h2 id={id} className="marketing-h2 mt-4">
        {title}
      </h2>
      {lead && <p className="marketing-body mt-4">{lead}</p>}
    </div>
  );
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-accent/20 text-accent-bright">
        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M4 10l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="text-sm leading-relaxed text-muted-foreground">{children}</span>
    </li>
  );
}

export function PrincipleStrip() {
  const principles = [
    { k: "EVIDENCE FIRST", v: "Every claim traces to observable transaction data." },
    { k: "CONFIDENCE QUANTIFIED", v: "Correlation strength and confidence are reported separately." },
    { k: "LIMITATIONS EXPOSED", v: "Counter-evidence and data-quality limits are shown, not hidden." }
  ];
  return (
    <section className="border-y border-white/10 bg-ink-raised/40">
      <div className="container-page grid gap-8 py-14 md:grid-cols-3 md:gap-6">
        {principles.map((p) => (
          <div key={p.k} className="flex flex-col gap-2">
            <span className="marketing-eyebrow">{p.k}</span>
            <p className="text-sm leading-relaxed text-muted-foreground">{p.v}</p>
          </div>
        ))}
      </div>
      <div className="container-page -mt-6 pb-10">
        <p className="text-center font-display text-lg font-semibold tracking-tight text-marble/90">
          Correlation <span className="text-accent-bright">≠</span> Ownership{" "}
          <span className="text-accent-bright">≠</span> Identity
        </p>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          AEGIX surfaces observable linkability between public wallets. It never identifies the person behind one.
        </p>
      </div>
    </section>
  );
}

export function HeroSection() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 bg-hero-glow" aria-hidden="true" />
      <div className="container-page relative grid items-center gap-10 py-20 md:grid-cols-2 md:py-28">
        <div>
          <p className="marketing-eyebrow">On-chain privacy intelligence · Solana</p>
          <h1 className="mt-4 font-display text-5xl font-semibold leading-[1.05] tracking-tightest text-marble md:text-7xl">
            Know What the
            <br />
            Blockchain Knows.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Understand what your public on-chain activity can reveal before someone else does. AEGIX turns
            observable Solana data into evidence-based privacy intelligence, with confidence and limitations
            made explicit.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/app/analyze" className="btn-primary">
              Analyze Your Wallet
            </Link>
            <Link href="/app/compare" className="btn-secondary">
              Compare Wallets
            </Link>
            <Link href="/methodology" className="btn-secondary border-transparent text-muted-foreground hover:text-marble">
              Explore Methodology
            </Link>
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            Signing in never costs SOL and creates no blockchain transaction.
          </p>
        </div>

        <div className="relative">
          <div className="card-surface overflow-hidden p-0">
            <Image
              src="/assets/aegix-wallet-intelligence.jpg"
              alt="AEGIX Wallet Intelligence interface showing a privacy exposure score, evidence breakdown, and linked entities"
              width={1280}
              height={720}
              priority
              className="h-auto w-full object-cover"
            />
          </div>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Wallet X-Ray — privacy exposure, evidence, and linked entities on public data.
          </p>
        </div>
      </div>
    </section>
  );
}

export function ProductSection() {
  const features = [
    {
      title: "Wallet X-Ray",
      body: "A Privacy Exposure Score, seven dimensions of observable exposure, and the evidence behind each signal.",
      cta: { label: "Analyze a Wallet", href: "/app/analyze" }
    },
    {
      title: "Attack My Wallet",
      body: "Simulated paths an observer could follow: target → funding → related wallet → entity → observable linkability.",
      cta: { label: "Explore Attack Paths", href: "/app/analyze" }
    },
    {
      title: "Compare Wallets",
      body: "Correlation strength reported separately from confidence, across funding, transfers, counterparties, entities, and behavior.",
      cta: { label: "Compare Wallets", href: "/app/compare" }
    },
    {
      title: "Privacy Monitor",
      body: "Continuous re-analysis, exposure and correlation changes, threat events, alert rules, in-app and email notifications.",
      cta: { label: "Start Monitoring", href: "/app/monitors" }
    }
  ];
  return (
    <section id="product" className="scroll-mt-16 py-20 md:py-28">
      <div className="container-page">
        <SectionHeading
          eyebrow="Product"
          title="Intelligence you can act on — and verify."
          lead="Every product surface is driven by real analysis, real evidence, and an explicit epistemic model."
        />
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="card-surface flex flex-col justify-between gap-6">
              <div>
                <h3 className="font-display text-xl font-semibold text-marble">{f.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
              <Link
                href={f.cta.href}
                className="inline-flex items-center gap-1 text-sm font-semibold text-accent-bright transition hover:text-marble"
              >
                {f.cta.label}
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 10h12m0 0l-4-4m4 4l-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function IntelligenceSection() {
  const dimensions = [
    "Identity Linkability",
    "Funding Exposure",
    "Exchange / Entity Exposure",
    "Wallet Cluster Exposure",
    "Behavioral Fingerprint",
    "Counterparty Exposure",
    "Transaction Pattern Exposure"
  ];
  return (
    <section id="intelligence" className="scroll-mt-16 border-t border-white/10 bg-ink-raised/30 py-20 md:py-28">
      <div className="container-page grid items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="marketing-eyebrow">Intelligence Engine</p>
          <h2 className="marketing-h2 mt-4">Deterministic. Evidence-backed. Bounded.</h2>
          <p className="marketing-body mt-4">
            AEGIX derives signals from normalized on-chain data through a deterministic pipeline — not
            generative guessing. Each stage is versioned and inspectable.
          </p>

          <div className="mt-8 space-y-2 font-mono text-sm text-muted-foreground">
            {["ON-CHAIN DATA", "NORMALIZATION", "SIGNALS", "CORRELATION", "GRAPH", "EXPOSURE"].map((step, i, arr) => (
              <div key={step} className="flex items-center gap-3">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <span className="text-marble/90">{step}</span>
                {i < arr.length - 1 && <span className="text-accent-bright">↓</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="card-surface">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Wallet X-Ray dimensions
          </h3>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2">
            {dimensions.map((d) => (
              <CheckItem key={d}>{d}</CheckItem>
            ))}
          </ul>
          <div className="mt-8 border-t border-white/10 pt-6">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Engine features
            </p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                "Funding Provenance",
                "Behavioral Similarity",
                "Temporal Correlation",
                "Entity Intelligence",
                "Multi-Hop Graph",
                "Cluster Hypothesis",
                "Population Commonality"
              ].map((f) => (
                <CheckItem key={f}>{f}</CheckItem>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export function DeveloperSection() {
  const items = ["Wallet Intelligence API", "Compare Intelligence API", "API Keys & Scopes", "Metered Quota", "Usage & Webhooks"];
  return (
    <section className="py-20 md:py-28">
      <div className="container-page grid items-center gap-12 lg:grid-cols-2">
        <div className="order-2 lg:order-1">
          <Image
            src="/assets/aegix-intelligence-infrastructure.jpg"
            alt="AEGIX intelligence infrastructure — servers and API layers, including signals, privacy, and data-layer APIs"
            width={1280}
            height={720}
            loading="lazy"
            className="h-auto w-full rounded-2xl border border-white/10"
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Vision asset — the labelled API surface includes future-facing infrastructure.
          </p>
        </div>
        <div className="order-1 lg:order-2">
          <p className="marketing-eyebrow">For Developers</p>
          <h2 className="marketing-h2 mt-4">Intelligence is infrastructure.</h2>
          <p className="marketing-body mt-4">
            Integrate AEGIX intelligence into your own tooling with scoped API keys, metered quota, usage
            reporting, and signed webhooks.
          </p>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {items.map((it) => (
              <CheckItem key={it}>{it}</CheckItem>
            ))}
          </ul>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/developers" className="btn-primary">
              Explore Developer API
            </Link>
            <Link href="/docs" className="btn-secondary">
              Read API Docs
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function VisionSection() {
  return (
    <section className="border-t border-white/10 py-20 md:py-28">
      <div className="container-page">
        <SectionHeading
          eyebrow="Vision"
          title="The future we build."
          lead="These directions represent AEGIX's long-term research roadmap, not products available today. Some concepts remain aspirational."
        />
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          <div className="card-surface overflow-hidden p-0">
            <Image
              src="/assets/aegix-market-structure.jpg"
              alt="AEGIX market structure concept — aspirational research direction"
              width={1280}
              height={720}
              loading="lazy"
              className="h-auto w-full object-cover"
            />
            <div className="p-5">
              <h3 className="font-display text-lg font-semibold text-marble">Market intelligence</h3>
              <p className="mt-2 text-sm text-muted-foreground">Brand / vision asset — not yet a live product.</p>
            </div>
          </div>
          <div className="card-surface overflow-hidden p-0">
            <Image
              src="/assets/aegix-intelligence-layer.jpg"
              alt="AEGIX intelligence layer sketch — research direction"
              width={1280}
              height={720}
              loading="lazy"
              className="h-auto w-full object-cover"
            />
            <div className="p-5">
              <h3 className="font-display text-lg font-semibold text-marble">Intelligence layer</h3>
              <p className="mt-2 text-sm text-muted-foreground">Research direction — not yet a live product.</p>
            </div>
          </div>
          <div className="card-surface overflow-hidden p-0">
            <Image
              src="/assets/aegix-ecosystem-vision.jpg"
              alt="AEGIX ecosystem vision — aspirational future direction"
              width={1280}
              height={720}
              loading="lazy"
              className="h-auto w-full object-cover"
            />
            <div className="p-5">
              <h3 className="font-display text-lg font-semibold text-marble">AEGIX ecosystem</h3>
              <p className="mt-2 text-sm text-muted-foreground">Brand / vision asset — not yet a live product.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function FinalCtaSection() {
  return (
    <section className="border-t border-white/10 bg-ink-raised/30 py-20 md:py-24">
      <div className="container-page text-center">
        <h2 className="marketing-h2">See what your wallet reveals.</h2>
        <p className="marketing-body mt-4 mx-auto max-w-xl">
          Analyze public blockchain exposure before someone else does — with evidence, confidence, and
          limitations made explicit.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/app/analyze" className="btn-primary">
            Launch AEGIX
          </Link>
          <Link href="/docs" className="btn-secondary">
            Read the Docs
          </Link>
        </div>
      </div>
    </section>
  );
}
