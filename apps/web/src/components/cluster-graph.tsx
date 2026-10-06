import type { DiscoveryCluster } from "@/lib/api";

const W = 680;
const H = 440;
const CENTRE = { x: W / 2, y: H / 2 };
const RADIUS = 150;
/** Series drawn on the ring; a larger cluster lists the rest under the drawing. */
const MAX_DRAWN = 16;

const short = (label: string, max = 26) => (label.length > max ? `${label.slice(0, max - 1)}…` : label);

/**
 * A cluster as a drawing: every series on a ring, the most connected at the
 * top, and one line per discovery that links two of them. Ink is a positive
 * correlation, orange a negative one. The lines are the discoveries; the
 * drawing adds nothing they do not say.
 */
export function ClusterGraph({ cluster }: { cluster: DiscoveryCluster }) {
  const drawn = cluster.series.slice(0, MAX_DRAWN);
  const position = new Map(drawn.map((series, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / drawn.length;
    return [series.key, { x: CENTRE.x + RADIUS * Math.cos(angle), y: CENTRE.y + RADIUS * Math.sin(angle), angle }] as const;
  }));
  const links = cluster.links.filter((link) => position.has(link.seriesA) && position.has(link.seriesB));
  const hidden = cluster.series.length - drawn.length;

  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" className="w-full max-w-3xl border border-ink/10 bg-paper-raised"
        aria-label={`${cluster.series.length} series joined by ${cluster.links.length} discoveries: ${cluster.series.map((s) => s.label).join(", ")}`}>
        {links.map((link) => {
          const from = position.get(link.seriesA)!;
          const to = position.get(link.seriesB)!;
          return <line key={link.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={link.direction === "NEGATIVE" ? "#f24011" : "#14120f"}
            strokeOpacity="0.55" strokeWidth={link.r === null ? 1 : 1 + 2 * Math.min(1, Math.abs(link.r))} />;
        })}
        {drawn.map((series) => {
          const p = position.get(series.key)!;
          const cos = Math.cos(p.angle);
          const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
          const dx = Math.abs(cos) < 0.2 ? 0 : cos > 0 ? 12 : -12;
          const dy = Math.abs(cos) < 0.2 ? (Math.sin(p.angle) < 0 ? -14 : 22) : 4;
          return (
            <g key={series.key}>
              <rect x={p.x - 6} y={p.y - 6} width="12" height="12" fill="#f24011" />
              <text x={p.x + dx} y={p.y + dy} textAnchor={anchor} className="fill-ink text-[10px] font-medium">{short(series.label)}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-xs text-muted-2">
        Each line is one discovery between the two series it joins; a thicker line is a stronger correlation. Ink is positive, orange negative.
        {hidden > 0 ? ` ${hidden} more series are in this cluster and are not drawn.` : ""}
      </figcaption>
    </figure>
  );
}
