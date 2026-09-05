"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Reveal — reveals children with a small opacity + translateY transition
 * when they enter the viewport (IntersectionObserver). No animation library.
 * Respects prefers-reduced-motion via the global CSS (`.reveal` is disabled
 * there) because the inline hidden class is overridden by the media query.
 *
 * Supports a `delay` (ms) so parent sections can stagger children.
 */
const TAGS = ["div", "section", "aside", "li", "article", "span", "p", "h1", "h2", "h3", "h4"] as const;
type RevealTag = (typeof TAGS)[number];

export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = "div",
  once = true
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: RevealTag;
  once?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  // tri-state: null = not yet mounted (SSR/pre-hydration) → content visible;
  // false = JS running, waiting for viewport; true = revealed.
  const [visible, setVisible] = useState<boolean | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // If reduced motion is active, show immediately (no observer needed).
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    // Once JS is running we start from hidden and reveal on viewport entry.
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
      { threshold: 0.1, rootMargin: "0px 0px -5% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  const Comp = Tag as React.ElementType;
  const revealed = visible === true;

  // Hidden inline style only after JS is running (visible === false). When
  // visible is null (SSR/pre-hydration) we render un-hidden so content stays
  // readable even if JS fails.
  const hiddenStyle: React.CSSProperties = {
    opacity: visible === false ? 0 : undefined,
    transform: visible === false ? "translateY(22px)" : undefined,
    filter: visible === false ? "blur(6px)" : undefined,
    transitionDelay: delay ? `${delay}ms` : undefined
  };

  return (
    <Comp
      ref={ref as React.Ref<never>}
      className={cn("reveal", revealed && "is-visible", className)}
      style={hiddenStyle}
    >
      {children}
    </Comp>
  );
}
