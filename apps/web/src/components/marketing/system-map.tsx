"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/cn";

/**
 * AEGIX Interactive System Map.
 *
 * Explains how public wallet activity becomes AEGIX intelligence through a
 * data-driven pipeline of six stages.
 *
 * Behaviors:
 *  - autoplays through stages when in view (~2600ms dwell, shown as a timer line)
 *  - pauses on hover/focus/click, resumes after ~3s idle
 *  - pauses when tab hidden or section out of viewport
 *  - keyboard accessible (Tab/Enter/Space)
 *  - reduced-motion: static map, manual selection only
 *  - each stage carries a local visualization that animates on entry
 */

export type StageId =
  | "SIGNAL"
  | "EVIDENCE"
  | "RELATIONSHIP"
  | "GRAPH"
  | "EXPOSURE"
  | "INTELLIGENCE";

interface Stage {
  id: StageId;
  category: string;
  title: string;
  action: string;
  description: string;
  /** small secondary detail line */
  detail: string;
}

const STAGES: Stage[] = [
  {
    id: "SIGNAL",
    category: "Signal",
    title: "Wallet Activity",
    action: "Observe",
    description:
      "AEGIX begins with public on-chain activity: transactions, token movements, protocol interactions, and counterparties.",
    detail: "Transactions · Tokens · Protocols · Counterparties"
  },
  {
    id: "EVIDENCE",
    category: "Evidence",
    title: "Funding · Counterparty · Behavior",
    action: "Normalize",
    description:
      "Independent observations are normalized into evidence families before relationship scoring begins.",
    detail: "Funding · Counterparty · Behavior · Entity · Protocol · Temporal"
  },
  {
    id: "RELATIONSHIP",
    category: "Relationship",
    title: "Correlation Engine",
    action: "Correlate",
    description:
      "Multiple evidence families are combined while common activity and weak observations are discounted.",
    detail: "Multi-evidence · Population-aware"
  },
  {
    id: "GRAPH",
    category: "Graph",
    title: "Paths · Clusters",
    action: "Trace",
    description:
      "AEGIX traces bounded relationship paths and surfaces the strongest observable routes between wallets and entities.",
    detail: "Multi-hop · Bounded · Cluster hypotheses"
  },
  {
    id: "EXPOSURE",
    category: "Exposure",
    title: "7 Dimensions",
    action: "Score",
    description:
      "Observable signals are evaluated across seven privacy-exposure dimensions while score and confidence remain separate.",
    detail: "Linkability · Funding · Entity · Cluster · Behavior · Counterparty · Pattern"
  },
  {
    id: "INTELLIGENCE",
    category: "Intelligence",
    title: "Evidence · Confidence",
    action: "Interpret",
    description:
      "AEGIX turns observable blockchain evidence into explainable intelligence without treating correlation as proof of ownership or identity.",
    detail: "Evidence · Strength · Confidence · Limitations"
  }
];

const DWELL_MS = 2600;
const RESUME_MS = 3000;

function fmt(n: number) {
  return String(n + 1).padStart(2, "0");
}

const at = (i: number) => ({ "--i": i }) as React.CSSProperties;

/** Horizontal centre of grid column `i` in a 6-column grid with gap-2. */
function columnCentre(i: number) {
  return `calc((100% - 2.5rem) / 6 * ${i + 0.5} + ${i * 0.5}rem)`;
}

/* ---------------------------- visuals ---------------------------- */

function SignalVisual() {
  const rows = [
    { k: "Transactions", v: "signatures · slots" },
    { k: "Token movements", v: "SPL in / out" },
    { k: "Protocol interactions", v: "program calls" },
    { k: "Counterparties", v: "wallets touched" }
  ];
  return (
    <ul className="sm-in space-y-2" aria-hidden="true">
      {rows.map((r, i) => (
        <li key={r.k} style={at(i)} className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] pb-2 last:border-0 last:pb-0">
          <span className="font-mono text-xs text-marble/90">{r.k}</span>
          <span className="font-mono text-[10px] text-muted-2">{r.v}</span>
        </li>
      ))}
    </ul>
  );
}

function EvidenceVisual() {
  const fams = ["Funding", "Counterparty", "Behavior", "Entity", "Protocol", "Temporal"];
  return (
    <div className="sm-in grid grid-cols-2 gap-1.5" aria-hidden="true">
      {fams.map((f, i) => (
        <span
          key={f}
          style={at(i)}
          className="flex items-center justify-between border border-white/10 px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {f}
          <span className="text-muted-2">{fmt(i)}</span>
        </span>
      ))}
    </div>
  );
}

function RelationshipVisual() {
  const fams = [
    { f: "Funding", w: 82 },
    { f: "Counterparty", w: 64 },
    { f: "Behavior", w: 48 },
    { f: "Temporal", w: 36 },
    { f: "Protocol", w: 22, discounted: true }
  ];
  return (
    <div aria-hidden="true">
      <div className="flex items-center justify-between font-mono text-[11px] text-marble/90">
        <span>Wallet A</span>
        <span className="text-muted-2">⇄</span>
        <span>Wallet B</span>
      </div>
      <div className="mt-3 space-y-2">
        {fams.map((r, i) => (
          <div key={r.f} className="grid grid-cols-[5.5rem_1fr] items-center gap-2 font-mono text-[10px]">
            <span className={r.discounted ? "text-muted-2 line-through decoration-white/30" : "text-muted-foreground"}>{r.f}</span>
            <span className="h-1 bg-white/[0.08]">
              <span
                className={cn("sm-bar block h-full", r.discounted ? "bg-white/25" : "bg-accent-bright")}
                style={{ ...at(i), width: `${r.w}%` }}
              />
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-[10px] text-muted-2">Protocol overlap discounted: common across population.</p>
    </div>
  );
}

function GraphVisual() {
  return (
    <div aria-hidden="true">
      <svg viewBox="0 0 220 128" className="block h-auto w-full">
        <g fill="none" strokeLinecap="round">
          <path d="M24 64 L110 30" pathLength={100} className="sm-draw" style={at(0)} stroke="#8b7cff" strokeWidth="1.5" />
          <path d="M110 30 L196 64" pathLength={100} className="sm-draw" style={at(1)} stroke="#8b7cff" strokeWidth="1.5" />
          <path d="M24 64 L110 100" pathLength={100} className="sm-draw" style={at(2)} stroke="rgba(255,255,255,0.22)" />
          <path d="M110 100 L196 64" pathLength={100} className="sm-draw" style={at(3)} stroke="rgba(255,255,255,0.22)" />
        </g>
        <g className="font-mono" fontSize="9">
          <g className="sm-pop" style={at(0)}>
            <circle cx="24" cy="64" r="4.5" fill="#8b7cff" />
            <text x="24" y="84" textAnchor="middle" fill="#f2f2f2">wallet A</text>
          </g>
          <g className="sm-pop" style={at(1)}>
            <circle cx="110" cy="30" r="4.5" fill="#050505" stroke="#8b7cff" strokeWidth="1.25" />
            <text x="110" y="16" textAnchor="middle" fill="#f2f2f2">wallet B</text>
          </g>
          <g className="sm-pop" style={at(2)}>
            <rect x="191" y="59" width="10" height="10" fill="#8b7cff" />
            <text x="196" y="84" textAnchor="middle" fill="#f2f2f2">entity</text>
          </g>
          <g className="sm-pop" style={at(3)}>
            <circle cx="110" cy="100" r="4.5" fill="#050505" stroke="rgba(255,255,255,0.45)" strokeWidth="1.25" />
            <text x="110" y="122" textAnchor="middle" fill="rgba(156,163,175,0.8)">wallet C</text>
          </g>
        </g>
      </svg>
      <p className="mt-2 font-mono text-[10px] text-muted-2">Strongest route: A → B → entity · 2 hops</p>
    </div>
  );
}

const DIMENSIONS = [
  "Identity Linkability",
  "Funding Exposure",
  "Exchange / Entity Exposure",
  "Wallet Cluster Exposure",
  "Behavioral Fingerprint",
  "Counterparty Exposure",
  "Transaction Pattern Exposure"
];

function ExposureVisual() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {DIMENSIONS.map((d, i) => (
        <div key={d} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-3">
          <span className="truncate font-mono text-[10px] text-muted-foreground">{d}</span>
          <span className="h-1 bg-white/[0.08]">
            <span className="sm-bar block h-full bg-accent-bright" style={{ ...at(i), width: `${32 + i * 9}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function IntelligenceVisual() {
  const items = [
    { k: "Exposure", v: "78 / 100" },
    { k: "Correlation", v: "71 / 100" },
    { k: "Confidence", v: "0.76" },
    { k: "Evidence", v: "5 families" }
  ];
  return (
    <div aria-hidden="true">
      <ul className="sm-in space-y-2">
        {items.map((it, i) => (
          <li key={it.k} style={at(i)} className="flex items-center justify-between border-b border-white/[0.06] pb-2 font-mono text-xs">
            <span className="text-muted-foreground">{it.k}</span>
            <span className="tabular-nums text-marble/90">{it.v}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-[10px] text-muted-2">Limitation: correlation is not proof of ownership.</p>
    </div>
  );
}

const VISUALS: Record<StageId, () => React.ReactNode> = {
  SIGNAL: SignalVisual,
  EVIDENCE: EvidenceVisual,
  RELATIONSHIP: RelationshipVisual,
  GRAPH: GraphVisual,
  EXPOSURE: ExposureVisual,
  INTELLIGENCE: IntelligenceVisual
};

/* ---------------------------- component ---------------------------- */

export function InteractiveSystemMap() {
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [held, setHeld] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [inView, setInView] = useState(false);
  // Assume reduced until mounted so SSR never renders timers.
  const [reducedMotion, setReducedMotion] = useState(true);
  const sectionRef = useRef<HTMLElement | null>(null);
  const resumeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  // Track viewport visibility so autoplay only runs in view.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setInView(entries[0]?.isIntersecting ?? false), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearTimeout(resumeTimer.current);
    };
  }, []);

  const playing = !reducedMotion && inView && !hovered && !focused && !held && !tabHidden;

  // Autoplay sequencing: one timeout per stage keeps the timer line in sync.
  useEffect(() => {
    if (!playing) return;
    const t = window.setTimeout(() => setActive((prev) => (prev + 1) % STAGES.length), DWELL_MS);
    return () => window.clearTimeout(t);
  }, [playing, active]);

  const select = useCallback((index: number) => {
    setActive(index);
    setHeld(true);
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => setHeld(false), RESUME_MS);
  }, []);

  const stage = STAGES[active]!;
  const Visual = VISUALS[stage.id];

  return (
    <section
      ref={sectionRef}
      className="border-b border-white/10"
      aria-label="AEGIX system map"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="px-4 py-20 md:py-28 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-end">
          <Reveal>
            <p className="section-label">The AEGIX system</p>
            <h2 className="section-title mt-5">From activity to intelligence.</h2>
          </Reveal>
          <Reveal delay={100} as="p" className="editorial-body max-w-md lg:justify-self-end">
            A deterministic intelligence pipeline for understanding observable wallet exposure and relationships.
          </Reveal>
        </div>

        <div className="mt-14">
          {/* horizontal rail (desktop) */}
          <div className="hidden md:block">
            <div className="relative mb-3 h-px bg-white/10" aria-hidden="true">
              {STAGES.map((s, i) => (
                <span
                  key={s.id}
                  className={cn("absolute top-0 h-2 w-px -translate-y-1/2", i <= active ? "bg-accent-bright" : "bg-white/25")}
                  style={{ left: columnCentre(i) }}
                />
              ))}
              <span
                className="absolute left-0 top-0 h-px bg-accent-bright transition-[width] duration-700 ease-out"
                style={{ width: columnCentre(active) }}
              />
              <span
                className="absolute top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 bg-accent-bright transition-[left] duration-700 ease-out"
                style={{ left: columnCentre(active) }}
              />
            </div>
            <div className="grid grid-cols-6 gap-2">
              {STAGES.map((s, i) => {
                const isActive = i === active;
                const isDone = i < active;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => select(i)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    className={cn(
                      "relative overflow-hidden border px-3 py-4 text-left transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright",
                      isActive
                        ? "border-accent-bright/50 bg-accent/[0.06]"
                        : isDone
                          ? "border-white/[0.12] bg-white/[0.02] hover:border-white/25"
                          : "border-white/[0.08] bg-transparent hover:border-white/20"
                    )}
                    aria-current={isActive ? "step" : undefined}
                  >
                    <span className={cn("font-mono text-[10px] uppercase tracking-wide", isActive ? "text-accent-bright" : "text-muted-2")}>
                      {fmt(i)}
                    </span>
                    <span className={cn("mt-3 block font-display text-sm font-semibold leading-tight", isActive ? "text-marble" : "text-muted-foreground")}>
                      {s.category}
                    </span>
                    <span className="mt-1 block font-mono text-[10px] leading-snug text-muted-2">{s.detail}</span>
                    <span className={cn("mt-3 block font-mono text-[10px] uppercase tracking-[0.14em]", isActive ? "text-accent-bright" : "text-muted-2")}>
                      {s.action}
                    </span>
                    {isActive && playing && (
                      <span
                        key={`p-${active}`}
                        className="step-progress absolute inset-x-0 bottom-0 h-px bg-accent-bright"
                        style={{ animationDuration: `${DWELL_MS}ms` }}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* detail panel */}
            <div className="system-map-detail mt-6 border border-white/10 p-6" aria-live={playing ? "off" : "polite"}>
              <div key={stage.id} className="grid gap-8 md:grid-cols-[minmax(0,1fr)_20rem]">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-bright">
                    {fmt(active)} / {fmt(STAGES.length - 1)} · {stage.category}
                  </p>
                  <h3 className="mt-3 font-serif text-3xl text-marble">{stage.title}</h3>
                  <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{stage.description}</p>
                  <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2">Action · {stage.action}</p>
                </div>
                <div className="border border-white/10 bg-black/30 p-4">
                  <Visual />
                </div>
              </div>
            </div>
          </div>

          {/* vertical rail (mobile) */}
          <div className="md:hidden">
            <div className="relative">
              <div className="absolute bottom-3 left-[1.05rem] top-3 w-px bg-white/10" aria-hidden="true" />
              <div className="space-y-1">
                {STAGES.map((s, i) => {
                  const isActive = i === active;
                  const isDone = i < active;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => select(i)}
                      className="relative flex w-full items-start gap-3 px-3 py-3 text-left"
                      aria-current={isActive ? "step" : undefined}
                    >
                      <span
                        className={cn(
                          "relative z-10 mt-1 h-2.5 w-2.5 flex-none border transition-colors duration-300",
                          isActive ? "border-accent-bright bg-accent-bright" : isDone ? "border-muted-foreground bg-muted-foreground/40" : "border-white/30 bg-ink-deep"
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0">
                        <span className={cn("flex items-center gap-2", isActive ? "text-marble" : "text-muted-foreground")}>
                          <span className="font-mono text-[10px] text-muted-2">{fmt(i)}</span>
                          <span className="font-display text-sm font-semibold">{s.category}</span>
                        </span>
                        <span className="mt-0.5 block font-mono text-[10px] text-muted-2">{s.detail}</span>
                        {isActive && <span className="mt-1 block font-mono text-[10px] uppercase tracking-wide text-accent-bright">{s.action}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* active detail */}
            <div className="system-map-detail mt-2 border border-white/10 p-5" aria-live={playing ? "off" : "polite"}>
              <div key={stage.id}>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-bright">
                  {fmt(active)} / {fmt(STAGES.length - 1)} · {stage.category}
                </p>
                <h3 className="mt-2 font-serif text-2xl text-marble">{stage.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{stage.description}</p>
                <div className="mt-4 border border-white/10 bg-black/30 p-3">
                  <Visual />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
