import type { SignalCategory } from "@aegix/types";

/**
 * Signals that report the absence of an observation.
 *
 * Absence of evidence is not evidence of absence. A wallet with no observed
 * incoming funding may be unfunded, or its funding may sit outside the
 * analysed window — the two are indistinguishable from here, so neither may
 * be presented as a contextual finding about the wallet.
 */
export const ABSENCE_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  "NO_INCOMING_FUNDING",
  "NO_COUNTERPARTIES"
]);

/**
 * Signals computed from other signals rather than from chain data.
 *
 * `analyzeLinkability` consumes every other category and emits a convergence
 * claim. Listing that claim beside the signals it consumed would report one
 * underlying fact two or three times, each time as though it were
 * independent corroboration.
 */
export const AGGREGATE_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  "CONVERGING_LINKABILITY_EVIDENCE"
]);

/**
 * Categories whose signals are statistical statements about a sample.
 *
 * Below the sufficiency threshold these describe the smallness of the
 * sample rather than anything about the wallet: three transactions at
 * similar hours is not an odd-hour concentration. Categories left out of
 * this set report specific observed events, which stay meaningful however
 * few of them there are.
 */
export const SPARSE_SENSITIVE_CATEGORIES: ReadonlySet<SignalCategory> = new Set<SignalCategory>([
  "BEHAVIORAL",
  "TRANSACTION_PATTERN"
]);

/**
 * Claims AEGIX cannot support from the evidence it holds.
 *
 * The deterministic engines already phrase their summaries carefully; this
 * is the backstop that keeps a future engine, or a changed summary, from
 * putting an identity or verdict claim in front of a user. Matching is on
 * whole words so that ordinary wording is not caught.
 */
const UNSAFE_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bbelongs? to\b/i,
  /\bowned by\b/i,
  /\bsame (owner|person|individual|user)\b/i,
  /\bis (a )?(fraud|fraudulent|scam|scammer|malicious|criminal)\b/i,
  /\bis (clean|safe|trustworthy|legitimate)\b/i,
  /\b(proves|proven|confirms|confirmed) that\b/i,
  /\bguarantee[ds]?\b/i,
  /\bdefinitely\b/i,
  /\bcertainly\b/i
];

export function containsUnsafeClaim(text: string): boolean {
  return UNSAFE_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Neutral stand-in used when a summary would otherwise carry an unsupported
 * claim. It says less rather than something wrong, and names the engine so
 * the finding stays traceable.
 */
export function neutralDescription(signalType: string, engine: string): string {
  return `AEGIX observed ${signalType} within the analysed history. Reported by ${engine}; see the evidence entries for the measured values.`;
}
