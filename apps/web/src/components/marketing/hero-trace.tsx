"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Hero relationship trace — an illustrative (not live) walk through the
 * evidence families AEGIX correlates around a single wallet.
 *
 *  - edges draw in and nodes settle on load (pure CSS)
 *  - the highlighted evidence family cycles while the panel is in view
 *  - pauses on hover, manual selection, hidden tab, or out of viewport
 *  - reduced motion: static drawing, manual selection only
 */

type Kind = "target" | "wallet" | "entity" | "program";

interface TraceNode {
  id: string;
  x: number;
  y: number;
  label: string;
  kind: Kind;
  anchor: "start" | "middle" | "end";
  lx: number;
  ly: number;
}

const NODES: TraceNode[] = [
  { id: "T", x: 240, y: 206, label: "4Nd1…q8Rz", kind: "target", anchor: "middle", lx: 0, ly: 32 },
  { id: "F", x: 104, y: 104, label: "funder", kind: "wallet", anchor: "middle", lx: 0, ly: -14 },
  { id: "F2", x: 40, y: 232, label: "funder · hop 2", kind: "wallet", anchor: "start", lx: -10, ly: 22 },
  { id: "X", x: 404, y: 86, label: "exchange deposit", kind: "entity", anchor: "end", lx: 10, ly: -15 },
  { id: "C", x: 432, y: 258, label: "counterparty", kind: "wallet", anchor: "end", lx: 10, ly: 22 },
  { id: "W", x: 128, y: 350, label: "wallet B", kind: "wallet", anchor: "middle", lx: 0, ly: 22 },
  { id: "P", x: 396, y: 356, label: "dex program", kind: "program", anchor: "middle", lx: 0, ly: 24 }
];

const NODE_BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<string, TraceNode>;

function edgePath(a: TraceNode, b: TraceNode, bend: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (a.x + b.x) / 2 + (-dy / len) * bend;
  const cy = (a.y + b.y) / 2 + (dx / len) * bend;
  return `M${a.x} ${a.y} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x} ${b.y}`;
}

const EDGES = [
  { id: "T-F", a: "T", b: "F", bend: 24 },
  { id: "F-F2", a: "F", b: "F2", bend: -22 },
  { id: "T-X", a: "T", b: "X", bend: -28 },
  { id: "T-C", a: "T", b: "C", bend: 16 },
  { id: "W-C", a: "W", b: "C", bend: 46 },
  { id: "T-W", a: "T", b: "W", bend: -16 },
  { id: "T-P", a: "T", b: "P", bend: 14 }
].map((e) => ({ ...e, d: edgePath(NODE_BY_ID[e.a]!, NODE_BY_ID[e.b]!, e.bend) }));

const STEPS = [
  {
    family: "Funding",
    title: "Funding provenance",
    note: "two hops back to a shared funder.",
    edges: ["T-F", "F-F2"],
    nodes: ["F", "F2"],
    weak: false
  },
  {
    family: "Entity",
    title: "Entity exposure",
    note: "direct deposits to a known exchange address.",
    edges: ["T-X"],
    nodes: ["X"],
    weak: false
  },
  {
    family: "Counterparty",
    title: "Shared counterparty",
    note: "wallet B pays the same distinctive address.",
    edges: ["T-C", "W-C"],
    nodes: ["C", "W"],
    weak: false
  },
  {
    family: "Protocol",
    title: "Common protocol",
    note: "a popular program — discounted as weak evidence.",
    edges: ["T-P"],
    nodes: ["P"],
    weak: true
  }
];

const STEP_MS = 3400;
const RESUME_MS = 6000;
const ACCENT = "#8b7cff";

const at = (i: number) => ({ "--i": i }) as React.CSSProperties;

export function HeroTrace() {
  const [step, setStep] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [held, setHeld] = useState(false);
  const [inView, setInView] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  // Assume reduced until mounted so SSR never renders timers.
  const [reduced, setReduced] = useState(true);
  const ref = useRef<HTMLElement | null>(null);
  const resumeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setInView(entries[0]?.isIntersecting ?? false), { threshold: 0.3 });
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

  const playing = !reduced && inView && !hovered && !held && !tabHidden;

  useEffect(() => {
    if (!playing) return;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [playing, step]);

  const select = useCallback((index: number) => {
    setStep(index);
    setHeld(true);
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => setHeld(false), RESUME_MS);
  }, []);

  const current = STEPS[step]!;
  const hotEdges = new Set(current.edges);
  const hotNodes = new Set(["T", ...current.nodes]);
  const target = NODE_BY_ID.T!;

  return (
    <figure
      ref={ref}
      className="border border-white/10 bg-black/40"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-2.5">
        <span className="mono-label text-muted-foreground">Relationship trace</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">Illustrative · not live data</span>
      </div>

      <div className="px-2 pt-3 sm:px-4">
        <svg viewBox="0 0 480 404" className="block h-auto w-full" role="img" aria-label="Illustrative relationship trace around one wallet">
          <g className="trace-ring" fill="none" stroke="rgba(255,255,255,0.08)">
            <circle cx={target.x} cy={target.y} r="118" strokeDasharray="2 5" />
            <circle cx={target.x} cy={target.y} r="212" strokeDasharray="2 5" />
          </g>
          <text
            className="trace-ring font-mono"
            x={target.x}
            y={target.y - 124}
            textAnchor="middle"
            fontSize="9"
            letterSpacing="0.12em"
            fill="rgba(255,255,255,0.3)"
          >
            1 HOP
          </text>

          <g fill="none" strokeLinecap="round">
            {EDGES.map((e, idx) => {
              const hot = hotEdges.has(e.id);
              return (
                <path
                  key={e.id}
                  d={e.d}
                  pathLength={100}
                  className={cn("trace-edge", hot && current.weak && "is-weak")}
                  style={at(idx)}
                  stroke={hot ? (current.weak ? "rgba(139,124,255,0.6)" : ACCENT) : "rgba(255,255,255,0.16)"}
                  strokeWidth={hot ? 1.6 : 1}
                />
              );
            })}
          </g>

          {!reduced && !current.weak && (
            <g fill="none" strokeLinecap="round" stroke="#d4ceff" strokeWidth="2.6">
              {EDGES.filter((e) => hotEdges.has(e.id)).map((e, idx) => (
                <path key={`${step}-${e.id}`} d={e.d} pathLength={100} className="trace-pulse" style={at(idx)} />
              ))}
            </g>
          )}

          {NODES.map((n, idx) => {
            const hot = hotNodes.has(n.id);
            const stroke = hot ? ACCENT : "rgba(255,255,255,0.45)";
            return (
              <g key={n.id} className="trace-node" style={at(idx)}>
                {n.kind === "target" && (
                  <>
                    <circle cx={n.x} cy={n.y} r="7" fill="none" stroke={ACCENT} className="trace-ping" opacity="0" />
                    <circle cx={n.x} cy={n.y} r="13" fill="none" stroke="rgba(139,124,255,0.35)" />
                    <circle cx={n.x} cy={n.y} r="6" fill={ACCENT} />
                  </>
                )}
                {n.kind === "wallet" && (
                  <circle cx={n.x} cy={n.y} r="5" fill={hot ? "rgba(139,124,255,0.25)" : "#050505"} stroke={stroke} strokeWidth="1.25" />
                )}
                {n.kind === "entity" && (
                  <rect x={n.x - 5} y={n.y - 5} width="10" height="10" fill={hot ? ACCENT : "#050505"} stroke={stroke} strokeWidth="1.25" />
                )}
                {n.kind === "program" && (
                  <path
                    d={`M${n.x} ${n.y - 6.5} L${n.x + 6.5} ${n.y} L${n.x} ${n.y + 6.5} L${n.x - 6.5} ${n.y} Z`}
                    fill="#050505"
                    stroke={stroke}
                    strokeWidth="1.25"
                  />
                )}
                <text
                  x={n.x + n.lx}
                  y={n.y + n.ly}
                  textAnchor={n.anchor}
                  className="trace-label font-mono"
                  letterSpacing="0.02em"
                  fill={hot ? "#f2f2f2" : "rgba(156,163,175,0.75)"}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <figcaption className="min-h-[5.25rem] border-t border-white/10 px-4 py-4" aria-live={playing ? "off" : "polite"}>
        <div key={step} className="trace-caption">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent-bright">
            Evidence {String(step + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")} · {current.family}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-marble">
            {current.title} <span className="text-muted-foreground">— {current.note}</span>
          </p>
        </div>
      </figcaption>

      <div className="grid grid-cols-2 gap-px border-t border-white/10 bg-white/10 sm:grid-cols-4">
        {STEPS.map((s, i) => {
          const active = i === step;
          return (
            <button
              key={s.family}
              type="button"
              onClick={() => select(i)}
              aria-pressed={active}
              className={cn(
                "relative overflow-hidden bg-ink-deep px-4 py-3 text-left font-mono text-[11px] uppercase tracking-[0.12em] transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-bright",
                active ? "text-marble" : "text-muted-2 hover:text-muted-foreground"
              )}
            >
              {s.family}
              {active &&
                (playing ? (
                  <span
                    key={`p-${step}`}
                    className="step-progress absolute inset-x-0 top-0 h-px bg-accent-bright"
                    style={{ animationDuration: `${STEP_MS}ms` }}
                    aria-hidden="true"
                  />
                ) : (
                  <span className="absolute inset-x-0 top-0 h-px bg-accent-bright" aria-hidden="true" />
                ))}
            </button>
          );
        })}
      </div>
    </figure>
  );
}
