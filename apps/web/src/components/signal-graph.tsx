import type { DiscoveryCard } from "@aegix/discovery";

export interface RelatedDiscovery { id: string; status: string; seriesA: string; seriesB: string; lagHours: number; direction: string }

const W = 680;
const MAIN_X = { a: 230, b: 450 } as const;
const MAX_NEIGHBOURS = 4;

/** Breaks a label into at most two lines near the middle, at a space. */
function wrap(label: string, max = 24): string[] {
  if (label.length <= max) return [label];
  const cut = label.lastIndexOf(" ", max);
  const at = cut > 8 ? cut : max;
  const rest = label.slice(at).trim();
  return [label.slice(0, at), rest.length > max ? `${rest.slice(0, max - 1)}…` : rest];
}

const lagLabel = (lagHours: number) => (lagHours === 0 ? "no lag" : lagHours % 24 === 0 && lagHours >= 24 ? `${lagHours / 24}d later` : `${lagHours}h later`);

/**
 * The relationship as a drawing: the two series of this discovery in the
 * middle, and around each the other series it has a discovery with. An arrow
 * runs from the series that moves first to the one that follows; a line with
 * no arrowhead is a same-step relationship. Ink is a positive correlation,
 * orange a negative one.
 */
export function SignalGraph({ card, related }: { card: DiscoveryCard; related: RelatedDiscovery[] }) {
  const [a, b] = card.graph.nodes;
  if (!a || !b) return null;
  // The strongest edge is drawn; every edge is listed under the drawing.
  const main = [...card.graph.edges].sort((x, y) => Math.abs(y.r) - Math.abs(x.r))[0];

  const neighbours = { a: [] as RelatedDiscovery[], b: [] as RelatedDiscovery[] };
  for (const r of related) {
    const touchesA = r.seriesA === a.id || r.seriesB === a.id;
    const touchesB = r.seriesA === b.id || r.seriesB === b.id;
    if (touchesA === touchesB) continue;
    const side = touchesA ? neighbours.a : neighbours.b;
    if (side.length < MAX_NEIGHBOURS) side.push(r);
  }
  const hidden = related.length - neighbours.a.length - neighbours.b.length;
  // With nothing around the pair the drawing is one row, not an empty square.
  const surrounded = neighbours.a.length + neighbours.b.length > 0;
  const H = surrounded ? 320 : 150;
  const MAIN_Y = surrounded ? H / 2 : 62;

  const place = (side: "a" | "b", index: number, count: number) => {
    const x = side === "a" ? 24 : W - 24;
    const y = count === 1 ? MAIN_Y : 50 + (index * (H - 100)) / (count - 1);
    return { x, y };
  };
  const other = (r: RelatedDiscovery, self: string) => (r.seriesA === self ? r.seriesB : r.seriesA);
  const stroke = (direction: string) => (direction === "NEGATIVE" ? "#f24011" : "#14120f");

  const fromA = !main || main.from === a.id;
  const x1 = fromA ? MAIN_X.a : MAIN_X.b;
  const x2 = fromA ? MAIN_X.b : MAIN_X.a;
  const inset = 16 * Math.sign(x2 - x1);

  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" className="w-full max-w-3xl border border-ink/10 bg-paper-raised"
        aria-label={`${a.label} and ${b.label}${main ? `, r = ${main.r}, ${lagLabel(main.lagHours)}` : ""}${related.length ? `; ${related.length} other discoveries share one of these series` : ""}`}>
        <defs>
          <marker id="sg-arrow-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#14120f" />
          </marker>
          <marker id="sg-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#f24011" />
          </marker>
        </defs>

        {(["a", "b"] as const).flatMap((side) => neighbours[side].map((r, i) => {
          const p = place(side, i, neighbours[side].length);
          const hub = { x: MAIN_X[side], y: MAIN_Y };
          const label = other(r, side === "a" ? a.id : b.id);
          return (
            <g key={r.id}>
              <line x1={hub.x} y1={hub.y} x2={p.x} y2={p.y} stroke={stroke(r.direction)} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 3" />
              <circle cx={p.x} cy={p.y} r="5" fill="#efe6d3" stroke="#14120f" strokeOpacity="0.5" />
              <text x={side === "a" ? p.x - 8 : p.x + 8} y={p.y - 11} textAnchor={side === "a" ? "start" : "end"} className="fill-muted-foreground font-mono text-[9px]">{label.length > 28 ? `${label.slice(0, 27)}…` : label}</text>
              <text x={side === "a" ? p.x - 8 : p.x + 8} y={p.y + 18} textAnchor={side === "a" ? "start" : "end"} className="fill-muted-2 font-mono text-[9px]">#{r.id}</text>
            </g>
          );
        }))}

        {main ? (
          <g>
            <line x1={x1 + inset} y1={MAIN_Y} x2={x2 - inset} y2={MAIN_Y} stroke={stroke(card.direction)} strokeWidth="2"
              markerEnd={main.lagHours === 0 ? undefined : `url(#sg-arrow-${card.direction === "NEGATIVE" ? "accent" : "ink"})`} />
            <text x={(MAIN_X.a + MAIN_X.b) / 2} y={MAIN_Y - 12} textAnchor="middle" className="fill-ink font-mono text-[11px]">r = {main.r}</text>
            <text x={(MAIN_X.a + MAIN_X.b) / 2} y={MAIN_Y + 20} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">{lagLabel(main.lagHours)}</text>
          </g>
        ) : null}

        {([["a", a], ["b", b]] as const).map(([side, node]) => (
          <g key={node.id}>
            <rect x={MAIN_X[side] - 8} y={MAIN_Y - 8} width="16" height="16" fill="#f24011" />
            {wrap(node.label).map((line, i) => (
              <text key={line} x={MAIN_X[side]} y={MAIN_Y + 34 + i * 13} textAnchor="middle" className="fill-ink text-[11px] font-medium">{line}</text>
            ))}
            <text x={MAIN_X[side]} y={MAIN_Y - 18} textAnchor="middle" className="fill-muted-2 font-mono text-[9px] uppercase tracking-[0.12em]">{node.group.length > 22 ? `${node.group.slice(0, 21)}…` : node.group}</text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-2 text-xs text-muted-2">
        An arrow runs from the series that moves first to the one that follows. Ink is a positive correlation, orange a negative one.
        {related.length ? ` Dashed lines are other discoveries that share one of these series${hidden > 0 ? `; ${hidden} more are not drawn` : ""}.` : ""}
      </figcaption>
    </figure>
  );
}
