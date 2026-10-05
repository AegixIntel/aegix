"use client";

import { useEffect, useRef, useState } from "react";

/** A connection the visitor pays for by the megabyte, or one that is slow. */
function constrained(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return Boolean(connection?.saveData) || /(^|-)2g$|^3g$/.test(connection?.effectiveType ?? "");
}

/**
 * A silent looping brand film. Nothing of it is fetched until it is near the
 * screen: then the poster, and the film only once it plays. It plays only
 * while it is on screen. Under reduced motion, or on a metered or slow
 * connection, it stays on its poster until the viewer presses play.
 */
export function PlateVideo({ src, poster, label, className }: { src: string; poster: string; label: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const approach = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) { setNear(true); approach.disconnect(); } },
      { rootMargin: "600px 0px" }
    );
    approach.observe(video);
    return () => approach.disconnect();
  }, []);

  // Set up once the film has its source: play() on a video without one is refused.
  useEffect(() => {
    const video = ref.current;
    if (!video || !near) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || constrained()) {
      video.controls = true;
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => { video.controls = true; });
        else video.pause();
      },
      { threshold: 0.25 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [near]);

  return <video ref={ref} className={className} src={near ? src : undefined} poster={near ? poster : undefined} muted loop playsInline preload="none" aria-label={label} />;
}
