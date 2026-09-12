"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Reveal — reveals children with a small opacity + translateY transition
 * when they enter the viewport (IntersectionObserver). No animation library.
 * Respects prefers-reduced-motion via the global CSS.
 *
 * Also exposes `data-reveal="waiting" | "shown"` so descendants can run their
 * own choreography (`.rv`, `.rv-line`, `.rv-mask`, `.rv-pop` in globals.css).
 * Pass `fade={false}` when only the descendants should animate.
 *
 * Supports a `delay` (ms) so parent sections can stagger children.
 */
const TAGS = ["div", "section", "aside", "li", "ul", "ol", "article", "span", "p", "h1", "h2", "h3", "h4"] as const;
type RevealTag = (typeof TAGS)[number];

export function Reveal({
  children,
  className,
  style,
  delay = 0,
  as: Tag = "div",
  once = true,
  fade = true
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  delay?: number;
  as?: RevealTag;
  once?: boolean;
  fade?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  // tri-state: null = not yet mounted (SSR/pre-hydration) → content visible;
  // false = JS running, waiting for viewport; true = revealed.
  const [visible, setVisible] = useState<boolean | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    // Already on screen at hydration: keep it shown instead of hiding and
    // replaying it, which would read as a flicker.
    const rect = el.getBoundingClientRect();
    if (once && rect.top < window.innerHeight * 0.92 && rect.bottom > 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            if (once) io.disconnect();
          } else if (!once) {
            setVisible(false);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  const Comp = Tag as React.ElementType;
  const waiting = visible === false;

  const inlineStyle: React.CSSProperties = {
    ...style,
    opacity: fade && waiting ? 0 : style?.opacity,
    transform: fade && waiting ? "translateY(18px)" : style?.transform,
    transitionDelay: delay ? `${delay}ms` : style?.transitionDelay
  };

  return (
    <Comp
      ref={ref as React.Ref<never>}
      className={cn(fade && "reveal", fade && visible === true && "is-visible", className)}
      style={inlineStyle}
      data-reveal={visible === null ? undefined : waiting ? "waiting" : "shown"}
    >
      {children}
    </Comp>
  );
}
