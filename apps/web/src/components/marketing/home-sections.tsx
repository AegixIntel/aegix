import Link from "next/link";
import { InlineArrowLink, StatusBadge } from "@/components/ui/primitives";
import { Reveal } from "@/components/motion/reveal";
import { InteractiveSystemMap } from "@/components/marketing/system-map";
import { TypedRequest } from "@/components/marketing/typed-request";
import { roadmapGroups, categoryProducts, productLineProducts } from "@/lib/site";

/** Stagger index consumed by the landing motion CSS (`--i`). */
function at(i: number) {
  return { "--i": i } as React.CSSProperties;
}

/* Category strip above hero — pillar names with their derived status. */
export function CategoryStrip() {
  return (
    <div className="flex items-center gap-x-8 overflow-x-auto whitespace-nowrap border-b border-ink/10 px-4 py-3 [scrollbar-width:none] lg:flex-wrap lg:px-8">
      {categoryProducts.map((it) => (
        <span key={it.id} className="flex flex-none items-center gap-2.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2">{it.name}</span>
          <StatusBadge label={it.status} />
        </span>
      ))}
    </div>
  );
}

/* System map — interactive AEGIX intelligence pipeline. */
export function SystemMap() {
  return <InteractiveSystemMap />;
}

/* Shared two-column section header: title left, supporting copy right. */
function SectionHeader({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-end">
      <Reveal>
        <p className="section-label">{label}</p>
        <h2 className="section-title mt-5 max-w-2xl">{title}</h2>
      </Reveal>
      <Reveal delay={100} as="p" className="editorial-body max-w-md lg:justify-self-end">
        {body}
      </Reveal>
    </div>
  );
}

/* How it works — a traced line connects three steps. */
export function HowItWorks() {
  const steps = [
    {
      n: "01",
      t: "Analyze a wallet",
      b: "Enter a Solana address. AEGIX fetches public activity and normalizes it.",
      artifact: "$ analyze 4Nd1…q8Rz"
    },
    {
      n: "02",
      t: "Read the evidence",
      b: "See exposure, dimensions, signals and verifiable evidence — not guesses.",
      artifact: "funding · entity · counterparty"
    },
    {
      n: "03",
      t: "Monitor the change",
      b: "Track exposure over time and get alerted to meaningful changes.",
      artifact: "exposure Δ → alert"
    }
  ];
  return (
    <section className="border-b border-ink/10">
      <div className="px-4 py-20 md:py-28 lg:px-8">
        <SectionHeader
          label="How it works"
          title="From on-chain activity to exposure."
          body="A wallet address goes in. A sourced exposure model comes out, and keeps being watched."
        />
        <Reveal fade={false} className="relative mt-16">
          <div className="absolute inset-x-0 top-0 h-px bg-ink/10" aria-hidden="true" />
          <div className="rv-line absolute inset-x-0 top-0 h-px bg-accent/70" style={at(1)} aria-hidden="true" />
          <ol className="grid gap-12 md:grid-cols-3 md:gap-8">
            {steps.map((s, i) => (
              <li key={s.n} className="relative pt-9">
                <span
                  className="rv-pop absolute left-0 top-0 h-2 w-2 -translate-y-1/2 bg-accent"
                  style={at(i * 4 + 2)}
                  aria-hidden="true"
                />
                <div className="rv" style={at(i * 4 + 3)}>
                  <span className="font-mono text-xs text-muted-2">{s.n}</span>
                  <h3 className="mt-3 font-display text-xl font-semibold text-ink">{s.t}</h3>
                  <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">{s.b}</p>
                  <p className="mt-6 border-l border-ink/15 pl-3 font-mono text-xs text-muted-foreground">{s.artifact}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}

/* Product line — indexed rows; hover traces a rule down the left edge.
   Rows come from `products` (PRODUCT_LINE surface), status included. */
export function ProductLine() {
  return (
    <section className="border-b border-ink/10">
      <div className="px-4 py-20 md:py-28 lg:px-8">
        <SectionHeader
          label="Product line"
          title="The rails, end to end."
          body="One loop: analyze on-chain activity, surface intelligence, monitor change."
        />
        <ul className="mt-14 border-t border-ink/10">
          {productLineProducts.map((p, i) => (
            <Reveal key={p.name} as="li" delay={i * 70}>
              <Link
                href={p.href}
                className="group relative block overflow-hidden border-b border-ink/10 transition-colors duration-300 hover:bg-ink/[0.02] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <span
                  className="absolute inset-y-0 left-0 w-px origin-bottom scale-y-0 bg-accent transition-transform duration-500 ease-out group-hover:scale-y-100"
                  aria-hidden="true"
                />
                <div className="grid gap-3 py-6 pr-4 transition-transform duration-500 ease-out group-hover:translate-x-4 md:grid-cols-[3.5rem_minmax(0,1fr)_9.5rem_13rem] md:items-baseline md:gap-6">
                  <span className="font-mono text-xs tabular-nums text-muted-2">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <h3 className="font-display text-xl font-semibold text-ink">{p.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{p.body}</p>
                  </div>
                  <div>
                    <StatusBadge label={p.status} />
                  </div>
                  <span className="flex items-center gap-3 font-mono text-xs text-muted-2 transition-colors duration-300 group-hover:text-ink md:justify-end">
                    {p.href}
                    <span className="text-accent-ink transition-transform duration-300 group-hover:translate-x-1" aria-hidden="true">
                      →
                    </span>
                  </span>
                </div>
              </Link>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* Developer infra — the actual request, typed out. */
export function DeveloperInfra() {
  const facts = ["Scoped API keys", "Metered quota", "Usage reporting", "Signed webhooks"];
  return (
    <section className="border-b border-ink/10">
      <div className="grid grid-cols-1 gap-14 px-4 py-20 md:py-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:px-8">
        <div className="min-w-0">
          <Reveal>
            <p className="section-label">Developers</p>
            <h2 className="section-title mt-5">Intelligence is infrastructure.</h2>
          </Reveal>
          <Reveal delay={100} as="p" className="mt-6 max-w-lg editorial-body">
            Applications can consume AEGIX intelligence programmatically. Submit a wallet, poll the analysis,
            or receive a signed webhook when it is ready.
          </Reveal>
          <Reveal fade={false} as="ul" className="mt-10 grid max-w-lg grid-cols-2 border-t border-ink/10">
            {facts.map((f, i) => (
              <li
                key={f}
                className="rv border-b border-ink/10 py-3 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground odd:pr-4"
                style={at(i + 1)}
              >
                {f}
              </li>
            ))}
          </Reveal>
          <Reveal delay={200} className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href="/developers" className="btn-primary">
              Open developer platform <span className="btn-arrow text-inherit">→</span>
            </Link>
            <Link href="/docs/api/wallet-intelligence" className="btn-secondary">
              Read the API reference
            </Link>
          </Reveal>
        </div>
        <Reveal delay={120} className="min-w-0">
          <TypedRequest />
        </Reveal>
      </div>
    </section>
  );
}

/* Epistemic principle — two sets approach and stop short of each other. */
export function Epistemic() {
  return (
    <section className="overflow-hidden border-b border-ink/10 bg-paper-raised">
      <Reveal fade={false}>
        <div className="px-4 py-24 text-center md:py-32 lg:px-10">
        <div className="relative mx-auto h-40 max-w-lg" aria-hidden="true">
          <div
            className="gap-circle gap-a flex h-32 w-32 items-center justify-center rounded-full border border-accent/60 bg-accent/[0.06]"
            style={{ transitionDelay: "120ms" }}
          >
            <span className="font-mono text-[10px] uppercase leading-snug tracking-[0.14em] text-accent-ink">
              Observed
              <br />
              relationship
            </span>
          </div>
          <div
            className="gap-circle gap-b flex h-32 w-32 items-center justify-center rounded-full border border-dashed border-ink/25"
            style={{ transitionDelay: "220ms" }}
          >
            <span className="font-mono text-[10px] uppercase leading-snug tracking-[0.14em] text-muted-foreground">
              Real-world
              <br />
              owner
            </span>
          </div>
          <span className="rv-pop absolute left-1/2 top-1/2 -ml-2 -mt-3 font-serif text-2xl text-ink" style={at(12)}>
            ≠
          </span>
        </div>
        <p className="rv mt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-2" style={at(14)}>
          AEGIX stops at the gap
        </p>
        <h2 className="statement mx-auto mt-10 max-w-3xl">
          <span className="rv-mask" style={at(2)}>
            <span>Correlation is not identity.</span>
          </span>
        </h2>
        <p className="rv mx-auto mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground" style={at(5)}>
          AEGIX reports observable relationships, evidence and confidence. It does not turn correlation into
          unsupported claims about real-world ownership.
        </p>
        </div>
      </Reveal>
    </section>
  );
}

/* Network / Solana + roadmap by status. */
export function NetworkAndRoadmap() {
  return (
    <section id="network" className="border-b border-ink/10">
      <div className="px-4 py-20 md:py-28 lg:px-8">
        <SectionHeader
          label="Network · Roadmap"
          title="Built for the real-time on-chain economy."
          body="AEGIX starts on Solana. The roadmap is status-driven, not date-driven: what has shipped, what is being built, and what comes later."
        />
        <Reveal fade={false} className="mt-14 grid gap-px border border-ink/10 bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
          {roadmapGroups.map((g, gi) => (
            <div key={g.label} className="bg-paper p-6">
              <div className="rv flex items-center justify-between" style={at(gi)}>
                <StatusBadge label={g.label} />
                <span className="font-mono text-[11px] tabular-nums text-muted-2">{String(g.items.length).padStart(2, "0")}</span>
              </div>
              <ul className="mt-6 space-y-2.5">
                {g.items.length === 0 ? (
                  <li className="text-sm text-muted-2">Nothing at this stage right now.</li>
                ) : g.items.map((item, ii) => (
                  <li
                    key={item.name}
                    title={item.note}
                    className={`rv flex items-center gap-2.5 text-sm ${g.label === "SHIPPED" ? "text-ink/90" : "text-muted-foreground"}`}
                    style={at(gi + ii * 0.6 + 1)}
                  >
                    <span
                      className={`h-1.5 w-1.5 flex-none ${g.label === "SHIPPED" ? "bg-accent" : "border border-ink/25"}`}
                      aria-hidden="true"
                    />
                    {item.name}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Reveal>
        <Reveal delay={120} className="mt-8">
          <InlineArrowLink href="/roadmap">Explore the roadmap</InlineArrowLink>
        </Reveal>
      </div>
    </section>
  );
}

