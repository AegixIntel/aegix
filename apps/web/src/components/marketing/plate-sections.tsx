import Image from "next/image";
import Link from "next/link";
import LiveStatsPanel from "@/components/live-stats-panel";
import { Reveal } from "@/components/motion/reveal";
import { PlateVideo } from "@/components/marketing/plate-video";
import { cn } from "@/lib/cn";
import { products } from "@/lib/site";

/** Stagger index consumed by the landing motion CSS (`--i`). */
function at(i: number) {
  return { "--i": i } as React.CSSProperties;
}

/* A brand plate. The plates carry their own headline on one side, so only
   the collage side is kept and the cut edge fades into the paper. The frame
   clips its image: a plate waiting to be revealed is drawn 14% larger, and
   unclipped it made the whole page scroll sideways. */
function Plate({
  src,
  alt,
  keep = "right",
  priority = false,
  className
}: {
  src: string;
  alt: string;
  keep?: "left" | "right";
  priority?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("plate relative aspect-[5/4] w-full overflow-hidden", className)}>
      <Image
        src={src}
        alt={alt}
        fill
        priority={priority}
        sizes="(min-width: 1024px) 50vw, 100vw"
        className={cn("plate-img object-cover", keep === "right" ? "plate-fade-left object-right" : "plate-fade-right object-left")}
      />
    </div>
  );
}

/* Mono caption with the plates' orange square marker. */
function Marked({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <p className={cn("section-label flex items-center gap-3", className)} style={style}>
      <span className="h-2 w-2 flex-none bg-accent" aria-hidden="true" />
      {children}
    </p>
  );
}

/* Hero — statement left, the brand plate right, live system numbers
   underneath. Motion here is CSS-only and runs on load. */
export function HeroStatement() {
  return (
    <section className="hero-ambient relative overflow-hidden border-b border-ink/10">
      <div className="relative z-10 grid gap-10 px-4 pb-14 pt-14 md:pt-20 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-6 lg:px-8">
        <div>
          <Marked className="hero-fade" style={at(0)}>
            AEGIX · Intelligence layer
          </Marked>
          <h1 className="statement-lg statement-hero mt-7">
            <span className="hero-line" style={at(0)}>
              <span>Financial</span>
            </span>
            <span className="hero-line" style={at(1)}>
              <span>&amp; On-Chain</span>
            </span>
            <span className="hero-line" style={at(2)}>
              <span className="text-accent">Intelligence.</span>
            </span>
          </h1>
          <p className="hero-fade mt-8 max-w-md font-mono text-[13px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground" style={at(3)}>
            AEGIX transforms public on-chain and financial data into relationships, patterns, signals and
            intelligence.
          </p>
          <p className="hero-fade mt-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2" style={at(4)}>
            Starting with privacy intelligence on Solana
          </p>
          <div className="hero-fade mt-10 flex flex-col gap-3 sm:flex-row" style={at(5)}>
            <Link href="/app/analyze" className="btn-primary">
              Launch AEGIX <span className="btn-arrow text-inherit">→</span>
            </Link>
            <Link href="/methodology" className="btn-secondary">
              Explore the intelligence layer
            </Link>
          </div>
        </div>
        <div className="hero-fade" style={at(2)}>
          <Plate
            priority
            src="/assets/aegix-financial-onchain-intelligence.jpg"
            alt="A marble head at the centre of a collage of stock charts, oil rigs, a central bank, container ships and on-chain graphs, joined by thin orange lines"
          />
        </div>
      </div>
      <div className="relative z-10 border-t border-ink/10">
        <LiveStatsPanel />
      </div>
    </section>
  );
}

/* The problem — signals exist, in separate places. */
export function Fragmented() {
  const markets = ["Stock markets", "Commodities", "Foreign exchange", "Macro economy", "On-chain activity", "Narratives"];
  return (
    <section className="border-b border-ink/10">
      <Reveal fade={false} className="grid gap-10 px-4 py-20 md:py-28 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-center lg:gap-6 lg:px-8">
        <Plate
          className="order-2 lg:order-1"
          src="/assets/aegix-fragmented-markets.jpg"
          alt="Broken stone blocks drifting apart, each carrying one market: an exchange floor, oil pumps, banknotes, a central bank, a container port and a crowd holding headlines"
        />
        <div className="order-1 lg:order-2 lg:pl-8">
          <Marked className="rv" style={at(0)}>
            The problem
          </Marked>
          <h2 className="statement mt-6">
            <span className="rv-mask" style={at(1)}>
              <span>Modern markets are</span>
            </span>
            <span className="rv-mask" style={at(2)}>
              <span className="text-accent">fragmented.</span>
            </span>
          </h2>
          <p className="rv mt-7 max-w-md editorial-body" style={at(4)}>
            Capital, data and narratives move across different markets. The signals exist, but they sit in
            separate places and are read by separate people.
          </p>
          <ul className="mt-9 grid max-w-md grid-cols-2 border-t border-ink/15">
            {markets.map((m, i) => (
              <li
                key={m}
                className="rv border-b border-ink/15 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground odd:pr-4"
                style={at(i + 5)}
              >
                {m}
              </li>
            ))}
          </ul>
        </div>
      </Reveal>
    </section>
  );
}

/* The method — fragments in, relationships out. */
export function ConnectSignal() {
  const stages = [
    { t: "Raw data", b: "Public on-chain activity and market series, captured with their source and time." },
    { t: "Relationships", b: "Correlations, patterns and anomalies, each with the evidence it rests on." },
    { t: "Signal", b: "What changed and how strong it is, with confidence reported separately." }
  ];
  return (
    <section className="border-b border-ink/10">
      <Reveal fade={false} className="grid gap-10 px-4 py-20 md:py-28 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-6 lg:px-8">
        <div>
          <Marked className="rv" style={at(0)}>
            The method
          </Marked>
          <h2 className="statement mt-6">
            <span className="rv-mask" style={at(1)}>
              <span>Connect the data.</span>
            </span>
            <span className="rv-mask" style={at(2)}>
              <span className="text-accent">Find the signal.</span>
            </span>
          </h2>
          <p className="rv mt-7 max-w-md editorial-body" style={at(4)}>
            From fragmented information to meaningful intelligence.
          </p>
          <ol className="mt-9 max-w-md border-t border-ink/15">
            {stages.map((s, i) => (
              <li key={s.t} className="rv grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 border-b border-ink/15 py-4" style={at(i + 5)}>
                <span className="font-mono text-xs tabular-nums text-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-ink">{s.t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.b}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <Plate
          keep="left"
          src="/assets/aegix-connect-the-data.jpg"
          alt="A hand lowering a glass prism marked with the AEGIX symbol; scattered market, commodity, macro and news fragments stream into it and leave as ordered panels"
        />
      </Reveal>
    </section>
  );
}

/* Privacy intelligence — the product that is live today. */
export function Exposure() {
  return (
    <section className="border-b border-ink/10">
      <Reveal fade={false} className="grid gap-10 px-4 py-20 md:py-28 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-6 lg:px-8">
        <div>
          <Marked className="rv" style={at(0)}>
            Privacy intelligence · Solana
          </Marked>
          <h2 className="statement mt-6">
            <span className="rv-mask" style={at(1)}>
              <span>Your digital</span>
            </span>
            <span className="rv-mask" style={at(2)}>
              <span>
                <span className="text-accent">exposure</span> is real.
              </span>
            </span>
          </h2>
          <p className="rv mt-7 max-w-md editorial-body" style={at(4)}>
            A public wallet leaves a trail: funding sources, counterparties, timing, exchange touchpoints.
            AEGIX shows you what that trail reveals before someone else reads it.
          </p>
          <div className="rv mt-10 flex flex-col gap-3 sm:flex-row" style={at(6)}>
            <Link href="/app/analyze" className="btn-primary">
              X-Ray a wallet <span className="btn-arrow text-inherit">→</span>
            </Link>
            <Link href="/privacy" className="btn-secondary">
              How privacy intelligence works
            </Link>
          </div>
        </div>
        <Plate
          src="/assets/aegix-digital-exposure.jpg"
          alt="A face in profile with an orange band across the eyes, surrounded by transaction lists, a fingerprint, a world map and silhouetted figures"
        />
      </Reveal>
    </section>
  );
}

/* Discovery Engine — the brand film, shown whole on an ink ground. */
export function DiscoveryFilm() {
  const discovery = products.find((p) => p.id === "aegix-discovery-engine");
  return (
    <section className="border-b border-ink/10 bg-ink text-paper">
      <div className="px-4 py-20 md:py-28 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-end">
          <Reveal>
            <p className="flex items-center gap-3 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-paper/60">
              <span className="h-2 w-2 flex-none bg-accent" aria-hidden="true" />
              AEGIX Discovery Engine
              {discovery && (
                <span className="border border-accent/60 px-1.5 py-0.5 text-[10px] tracking-[0.12em] text-accent">{discovery.status}</span>
              )}
            </p>
            <h2 className="mt-6 max-w-2xl font-serif text-4xl font-medium leading-[1.04] tracking-[-0.018em] md:text-5xl lg:text-[3.4rem]">
              What if you didn&apos;t need to know what to <span className="text-accent">search for?</span>
            </h2>
          </Reveal>
          <Reveal delay={100} as="p" className="max-w-md text-base leading-relaxed text-paper/70 md:text-lg lg:justify-self-end">
            The Discovery Engine scans the series AEGIX records and reports the relationships it finds,
            including the ones nobody asked about. Each is stored with its own Discovery ID.
          </Reveal>
        </div>
        <Reveal fade={false} className="mt-12">
          <div className="plate relative border border-paper/15">
            <PlateVideo
              className="block aspect-[1280/732] w-full bg-paper object-cover"
              src="/assets/aegix-discovery-engine.mp4"
              poster="/assets/aegix-discovery-engine-poster.jpg"
              label="AEGIX brand film: a marble head opens into layers of ships, chips, power lines and markets beside a card labelled Discovery ID"
            />
          </div>
        </Reveal>
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_auto] lg:items-start">
          {discovery?.note && (
            <Reveal as="p" className="max-w-3xl font-mono text-[11px] uppercase leading-relaxed tracking-[0.12em] text-paper/55">
              Scope today — {discovery.note}
            </Reveal>
          )}
          <Reveal delay={100} className="flex flex-col gap-3 sm:flex-row">
            <Link href="/app/discoveries" className="btn-primary btn-on-ink">
              Open discoveries <span className="btn-arrow text-inherit">→</span>
            </Link>
            <Link href="/app/rewind" className="btn-secondary btn-on-ink">
              Replay with Rewind
            </Link>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* Final CTA. */
export function FinalCta() {
  return (
    <section className="overflow-hidden">
      <Reveal fade={false} className="grid gap-10 px-4 py-20 md:py-28 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-6 lg:px-8">
        <div>
          <Marked className="rv" style={at(0)}>
            Start here
          </Marked>
          <h2 className="statement-lg mt-6">
            <span className="rv-mask" style={at(1)}>
              <span>See beyond</span>
            </span>
            <span className="rv-mask" style={at(2)}>
              <span className="text-accent">the obvious.</span>
            </span>
          </h2>
          <p className="rv mt-8 max-w-md text-lg text-muted-foreground" style={at(4)}>
            Start with your own wallet. One address, every observable link, with evidence and confidence
            attached.
          </p>
          <div className="rv mt-10 flex flex-col gap-3 sm:flex-row" style={at(5)}>
            <Link href="/app/analyze" className="btn-primary">
              Launch AEGIX <span className="btn-arrow text-inherit">→</span>
            </Link>
            <Link href="/docs" className="btn-secondary">
              Read the docs
            </Link>
          </div>
        </div>
        <Plate
          src="/assets/aegix-beyond-the-obvious.jpg"
          alt="A lone figure on a rock ledge facing a road of charts that winds through mountains to a bright stone gateway"
        />
      </Reveal>
    </section>
  );
}
