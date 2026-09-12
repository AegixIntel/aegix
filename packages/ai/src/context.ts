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
 */
export function buildBoundedContext(
  items: EvidenceItem[],
  bounds: ContextBounds = DEFAULT_CONTEXT_BOUNDS
): BoundedContext {
  const ranked = [...items].sort(
    (a, b) => b.severity * b.confidence - a.severity * a.confidence || a.id.localeCompare(b.id)
  );

  const lines: string[] = [];
  const includedIds: string[] = [];
  let chars = 0;

  for (const item of ranked) {
    if (includedIds.length >= bounds.maxItems) break;
    const detail = item.untrusted ? sanitizeUntrusted(item.detail) : item.detail;
    const label = item.untrusted ? sanitizeUntrusted(item.label) : item.label;
    const line = `${item.id} | ${label} | severity ${item.severity} | confidence ${item.confidence.toFixed(2)} | ${detail}`;
    if (chars + line.length > bounds.maxChars) break;
    lines.push(line);
    includedIds.push(item.id);
    chars += line.length;
  }

  const droppedCount = ranked.length - includedIds.length;
  const header =
    droppedCount > 0
      ? `Showing the ${includedIds.length} highest-ranked items of ${ranked.length}. ${droppedCount} were omitted; say so if a question depends on what is missing.`
      : `All ${includedIds.length} available items are shown.`;

  return {
    block: fenceUntrusted([header, ...lines].join("\n")),
    includedIds,
    droppedCount,
    truncated: droppedCount > 0
  };
}
