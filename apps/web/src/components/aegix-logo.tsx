/** Brand mark for AEGIX: a triangular "A" glyph + wordmark. */
export function AegixMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden="true">
      <path
        d="M24 6 L42 40 H35.5 L29 28.5 H19 L12.5 40 H6 Z"
        fill="currentColor"
      />
      <path d="M21.5 23.5 H26.5 L24 18.8 Z" fill="#05070d" />
    </svg>
  );
}

export function AegixLogo({ className = "h-7" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-marble ${className}`}>
      <AegixMark className="h-6 w-6" />
      <span className="font-display text-lg font-semibold tracking-tight">AEGIX</span>
    </span>
  );
}
