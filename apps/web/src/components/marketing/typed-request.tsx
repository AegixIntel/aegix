"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Developer request preview. Types the real wallet-intelligence request
 * when scrolled into view, then shows the 202 response shape returned by
 * apps/api/src/developer-intelligence.ts. Server render and reduced motion
 * show the finished state.
 */

type Seg = { t: string; c?: string };

const REQUEST: Seg[] = [
  { t: "POST", c: "text-accent-bright" },
  { t: " /v1/developer/intelligence/wallet\n" },
  { t: "Authorization:", c: "text-muted-2" },
  { t: " Bearer aegix_live_…\n" },
  { t: "Content-Type:", c: "text-muted-2" },
  { t: " application/json\n\n" },
  { t: '{ "wallet": "<SOLANA_ADDRESS>" }' }
];

const RESPONSE = `{
  "data": {
    "analysisId": "<id>",
    "status": "CREATED",
    "pollUrl": "/v1/developer/intelligence/analysis/<id>"
  },
  "meta": { "requestId": "…", "timestamp": "…" }
}`;

const TOTAL = REQUEST.reduce((n, s) => n + s.t.length, 0);
const CHAR_MS = 15;
const LATENCY_MS = 520;

export function TypedRequest() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState(TOTAL);
  const [responded, setResponded] = useState(true);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setArmed(true);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!armed || !el) return;
    setTyped(0);
    setResponded(false);
    let raf = 0;
    let timer = 0;
    const start = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const n = Math.min(TOTAL, Math.floor((now - t0) / CHAR_MS));
        setTyped(n);
        if (n < TOTAL) raf = requestAnimationFrame(tick);
        else timer = window.setTimeout(() => setResponded(true), LATENCY_MS);
      };
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          io.disconnect();
          start();
        }
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [armed, run]);

  let offset = 0;
  const showCaret = armed && !responded;

  return (
    <div ref={ref} className="border border-white/10 bg-black/40 font-mono text-[13px] leading-relaxed">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="mono-label text-muted-foreground">Request</span>
        {armed && (
          <button
            type="button"
            onClick={() => setRun((r) => r + 1)}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2 transition-colors hover:text-marble"
          >
            Replay
          </button>
        )}
      </div>
      <pre className="overflow-x-auto px-4 py-4 text-marble/90">
        <code>
          {REQUEST.map((s, idx) => {
            const start = offset;
            offset += s.t.length;
            const shown = s.t.slice(0, Math.max(0, typed - start));
            const caretHere = showCaret && typed >= start && (typed < offset || (typed === TOTAL && idx === REQUEST.length - 1));
            return (
              <span key={idx} className={s.c}>
                {shown}
                {caretHere && <span className="caret" aria-hidden="true" />}
                <span className="invisible">{s.t.slice(shown.length)}</span>
              </span>
            );
          })}
        </code>
      </pre>

      <div className="flex items-center justify-between border-y border-white/10 px-4 py-2.5">
        <span className="mono-label text-muted-foreground">Response</span>
        <span className={cn("font-mono text-[11px]", responded ? "text-emerald-400" : "text-muted-2")}>
          {responded ? "202 Accepted" : typed === TOTAL ? "sending…" : "—"}
        </span>
      </div>
      <pre
        className={cn(
          "overflow-x-auto px-4 py-4 text-muted-foreground transition-[opacity,transform] duration-500",
          responded ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
        )}
      >
        <code>
          {RESPONSE.split(/("[^"]*")(?=\s*:)/).map((part, i) =>
            i % 2 === 1 ? (
              <span key={i} className="text-marble">
                {part}
              </span>
            ) : (
              part
            )
          )}
        </code>
      </pre>
    </div>
  );
}
