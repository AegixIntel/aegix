import { fenceUntrusted, sanitizeUntrusted } from "./sanitize.js";

/**
 * One citable fact, already reduced to text by the deterministic layer.
 *
 * `id` is the stable evidence identifier a model must cite. `untrusted` marks
 * text that originated on chain and therefore passes through sanitisation.
 */
export interface EvidenceItem {
  id: string;
  label: string;
  detail: string;
  severity: number;
  confidence: number;
  untrusted?: boolean;
}

export interface BoundedContext {
  block: string;
  includedIds: string[];
  /** How many items did not fit. The model is told this number. */
  droppedCount: number;
  truncated: boolean;
}

export interface ContextBounds {
  maxItems: number;
  maxChars: number;
}

export const DEFAULT_CONTEXT_BOUNDS: ContextBounds = { maxItems: 24, maxChars: 6000 };

/**
 * Ranks evidence deterministically and keeps as much as the bounds allow.
 *
 * Severity times confidence, because a severe finding nobody is sure of and a
 * certain finding of no consequence are both worth less than a severe finding
 * that holds up. Ties break on ID so the same analysis always produces the
 * same context — an unstable context would make the answer unstable too.
 *
 * `pinned` IDs are placed ahead of the ranking, in the same order among
 * themselves. A caller whose evidence spans several kinds uses it so that the
 * most numerous kind cannot push every item of another out of the block.
 */
export function buildBoundedContext(
  items: EvidenceItem[],
  bounds: ContextBounds = DEFAULT_CONTEXT_BOUNDS,
  pinned: ReadonlySet<string> = new Set()
): BoundedContext {
  const ranked = [...items].sort(
    (a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id))
      || b.severity * b.confidence - a.severity * a.confidence || a.id.localeCompare(b.id)
  );

  const lines: string[] = [];
  const includedIds: string[] = [];
  const headerFor = (count: number) => count < ranked.length
    ? `Showing the ${count} highest-ranked items of ${ranked.length}. ${ranked.length - count} were omitted; say so if a question depends on what is missing.`
    : `All ${count} available items are shown.`;
  const seen = new Set<string>();

  for (const item of ranked) {
    if (includedIds.length >= bounds.maxItems) break;
    if (!/^(sig|dim|ind|cov):[A-Za-z0-9_:.\-]+$/.test(item.id) || seen.has(item.id)) continue;
    const detail = item.untrusted ? sanitizeUntrusted(item.detail) : item.detail;
    const label = item.untrusted ? sanitizeUntrusted(item.label) : item.label;
    const line = `${item.id} | ${label} | severity ${item.severity} | confidence ${item.confidence.toFixed(2)} | ${detail}`;
    if (fenceUntrusted([headerFor(includedIds.length + 1), ...lines, line].join("\n")).length > bounds.maxChars) continue;
    lines.push(line);
    includedIds.push(item.id);
    seen.add(item.id);
  }

  const droppedCount = ranked.length - includedIds.length;
  const header = headerFor(includedIds.length);
  const block = fenceUntrusted([header, ...lines].join("\n"));

  return {
    block: block.length <= bounds.maxChars ? block : "",
    includedIds,
    droppedCount,
    truncated: droppedCount > 0
  };
}
