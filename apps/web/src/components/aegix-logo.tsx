/**
 * The official AEGIX mark, traced from the brand master
 * (front/assets/aegix logo.png, 1254×1254) in its own pixel coordinates:
 * the split "A" glyph matches the master's filled area at IoU 0.997. It is
 * drawn in `currentColor`, so it follows the surrounding text colour instead
 * of carrying the master's white background.
 */
export const AEGIX_MARK_VIEWBOX = "250 212 760 760";
export const AEGIX_MARK_PATH =
  "M630.5 287 L871 692 H736.5 L630.5 514.5 L475 774 H607 L534 898 H264 Z M684 768 H919 L996 898 H761 Z";

export function AegixMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox={AEGIX_MARK_VIEWBOX} className={className} aria-hidden="true">
      <path d={AEGIX_MARK_PATH} fill="currentColor" />
    </svg>
  );
}

export function AegixLogo({ className = "h-7" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-ink ${className}`}>
      <AegixMark className="h-6 w-6" />
      <span className="font-display text-lg font-semibold tracking-tight">AEGIX</span>
    </span>
  );
}
