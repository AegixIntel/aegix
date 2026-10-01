import type { SeriesDescriptor } from "@aegix/rewind";

/** One value of one series, ready for the observation ledger. */
export interface SeriesObservation {
  seriesKey: string;
  eventTime: string;
  value: number;
  /** Where the value came from. Stored on the ledger row, never in the key. */
  source: string;
}

/**
 * A source of ledger series.
 *
 * `collect` returns only what it actually read. A value that could not be
 * read, or did not pass the source's own identity checks, is left out: the
 * ledger then shows a gap, which is the truthful record.
 */
export interface SeriesSource {
  readonly name: string;
  /** Series from this source that the Discovery Engine scans. */
  readonly series: SeriesDescriptor[];
  collect(at: Date): Promise<SeriesObservation[]>;
}

export type SourceErrorCode = "TIMEOUT" | "RATE_LIMIT" | "PROVIDER_ERROR" | "MALFORMED_RESPONSE";

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

/** JSON over HTTP with a hard timeout, shared by every source. */
export async function fetchJson(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? "GET", body: options.body, signal: controller.signal,
      headers: { accept: "application/json", ...options.headers }
    });
    if (response.status === 429) throw new SourceError("RATE_LIMIT", "Source rate limited");
    if (!response.ok) throw new SourceError("PROVIDER_ERROR", `Source HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new SourceError(controller.signal.aborted ? "TIMEOUT" : "MALFORMED_RESPONSE", "Source response is not JSON"); }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(controller.signal.aborted ? "TIMEOUT" : "PROVIDER_ERROR", "Source request unavailable");
  } finally { clearTimeout(timer); }
}
