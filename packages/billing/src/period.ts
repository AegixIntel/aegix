/**
 * Billing period arithmetic. Every boundary is UTC, matching the existing
 * daily quota windows (D3-F, D6-D §68) so a billing period and a quota day
 * can never disagree about which day a usage record belongs to.
 */

import type { BillingInterval, BillingPeriod } from "./types.js";

/** The UTC day containing `now`. */
export function dayWindow(now: Date): BillingPeriod {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** The UTC calendar month containing `now`; the reporting period for free. */
export function calendarMonth(now: Date): BillingPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Advances an instant by one billing interval. Month arithmetic clamps to
 * the last day of the target month, so a period starting on the 31st renews
 * on the 28th/29th/30th rather than overflowing into the next month.
 */
export function addInterval(from: Date, interval: BillingInterval): Date {
  if (interval === "NONE") return new Date(from);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  const targetYear = interval === "YEAR" ? year + 1 : year;
  const targetMonth = interval === "YEAR" ? month : month + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    Math.min(day, lastDay),
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds()
  ));
}

/** The period a subscription on `interval` starting at `start` occupies. */
export function periodFrom(start: Date, interval: BillingInterval): BillingPeriod {
  if (interval === "NONE") return calendarMonth(start);
  return { start: start.toISOString(), end: addInterval(start, interval).toISOString() };
}

/** Whole UTC days in a period; the allowance multiplier for daily limits. */
export function daysInPeriod(period: BillingPeriod): number {
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return Math.round((end - start) / 86_400_000);
}
