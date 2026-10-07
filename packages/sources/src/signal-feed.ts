/**
 * Signal Engine: every stored signal of every domain on one timeline, and the
 * moments when several market classes held one at once. See
 * docs/milestone-d15-market-intelligence-engines.md §3.
 *
 * It is a reading of signal captures already on record. It runs no signal
 * engine of its own and stores nothing: every signal on it was computed and
 * stamped by the engine of its own domain, at capture time.
 *
 * A confluence says that signals of different classes were stored close in
 * time. It claims no link between them: classes that share a trading day
 * move in the same hours for reasons that have nothing to do with each other.
 */

export const SIGNAL_ENGINE_VERSION = "signal-engine-v1.0.0";

const HOUR_MS = 3_600_000;

/** Signals this close together are read as one moment. */
export const CONFLUENCE_WINDOW_HOURS = 6;
/** Distinct market classes that must hold a signal inside the window. */
export const CONFLUENCE_MIN_CLASSES = 3;

export type SignalDomain = "MARKET" | "NARRATIVE" | "SECTOR" | "ANOMALY";
export type MarketClass = "CRYPTO" | "TOKENIZED_EQUITY" | "NEWS" | "SECTOR_FUND" | "COMMODITY_FUND" | "OTHER";

export interface FeedCapture {
  id: string;
  domain: SignalDomain;
  subject: string;
  observedAt: string;
  signals: Array<{ type: string; severity: number; confidence: number; title: string; summary: string }>;
}

export interface FeedEntry {
  domain: SignalDomain;
  subject: string;
  label: string;
  marketClass: MarketClass;
  signalType: string;
  title: string;
  summary: string;
  peakSeverity: number;
  firstObservedAt: string;
  lastObservedAt: string;
  /** Captures in the window that held this signal. */
  captures: number;
}

export interface Confluence {
  from: string;
  to: string;
  classes: MarketClass[];
  subjects: Array<{ subject: string; label: string; marketClass: MarketClass; signalTypes: string[] }>;
}

export interface SignalFeed {
  engineVersion: string;
  entries: FeedEntry[];
  confluences: Confluence[];
  capturesRead: number;
}

/** What a capture's subject is: where it sits among the market classes, and its name in words. */
export type SubjectResolver = (domain: SignalDomain, subject: string) => { marketClass: MarketClass; label: string };

export function buildSignalFeed(input: { captures: readonly FeedCapture[]; resolve: SubjectResolver }): SignalFeed {
  const captures = [...input.captures].filter((c) => c.signals.length > 0 && Number.isFinite(Date.parse(c.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const resolved = captures.map((capture) => ({ capture, at: Date.parse(capture.observedAt), ...input.resolve(capture.domain, capture.subject) }));

  const entries = new Map<string, FeedEntry>();
  for (const { capture, marketClass, label } of resolved) {
    for (const signal of capture.signals) {
      const key = `${capture.domain}|${capture.subject}|${signal.type}`;
      const entry = entries.get(key);
      if (!entry) {
        entries.set(key, {
          domain: capture.domain, subject: capture.subject, label, marketClass, signalType: signal.type, title: signal.title, summary: signal.summary,
          peakSeverity: signal.severity, firstObservedAt: capture.observedAt, lastObservedAt: capture.observedAt, captures: 1
        });
        continue;
      }
      entry.captures += 1;
      entry.lastObservedAt = capture.observedAt;
      // The text shown is the strongest capture's, so the numbers in it match the peak.
      if (signal.severity > entry.peakSeverity) { entry.peakSeverity = signal.severity; entry.title = signal.title; entry.summary = signal.summary; }
    }
  }

  // A capture is confluent when the window ending at it holds enough classes.
  // Confluent captures less than a window apart are one episode.
  const windowMs = CONFLUENCE_WINDOW_HOURS * HOUR_MS;
  const confluences: Confluence[] = [];
  let open: { fromIndex: number; toIndex: number } | null = null;
  const close = () => {
    if (!open) return;
    const members = resolved.slice(open.fromIndex, open.toIndex + 1).filter((r) => r.marketClass !== "OTHER");
    const subjects = new Map<string, Confluence["subjects"][number]>();
    for (const member of members) {
      const key = `${member.marketClass}|${member.capture.subject}`;
      const subject = subjects.get(key) ?? { subject: member.capture.subject, label: member.label, marketClass: member.marketClass, signalTypes: [] };
      for (const signal of member.capture.signals) if (!subject.signalTypes.includes(signal.type)) subject.signalTypes.push(signal.type);
      subjects.set(key, subject);
    }
    confluences.push({
      from: members[0]!.capture.observedAt, to: members.at(-1)!.capture.observedAt,
      classes: [...new Set(members.map((m) => m.marketClass))].sort(),
      subjects: [...subjects.values()].sort((a, b) => a.marketClass.localeCompare(b.marketClass) || a.subject.localeCompare(b.subject))
    });
    open = null;
  };
  let start = 0;
  for (let end = 0; end < resolved.length; end++) {
    while (resolved[end]!.at - resolved[start]!.at >= windowMs) start += 1;
    const classes = new Set<MarketClass>();
    for (let i = start; i <= end; i++) if (resolved[i]!.marketClass !== "OTHER") classes.add(resolved[i]!.marketClass);
    if (classes.size < CONFLUENCE_MIN_CLASSES) continue;
    if (open && resolved[end]!.at - resolved[open.toIndex]!.at < windowMs) { open.toIndex = end; continue; }
    close();
    open = { fromIndex: start, toIndex: end };
  }
  close();

  return {
    engineVersion: SIGNAL_ENGINE_VERSION,
    entries: [...entries.values()].sort((a, b) => Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt) || b.peakSeverity - a.peakSeverity || a.subject.localeCompare(b.subject)),
    confluences: confluences.reverse(),
    capturesRead: captures.length
  };
}
