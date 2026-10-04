/**
 * The US equity session, for sources whose feed stands still outside it.
 *
 * A delayed-quote feed keeps answering on a Saturday with Friday's close. A
 * source that stored that answer would write a day of unchanged values, and
 * the daily scan would read it as a day on which nothing moved. So a session
 * source asks only while the market is open, and the ledger has a gap for
 * every other hour.
 */

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit"
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** New York wall-clock time: the date, the weekday (0 = Sunday) and minutes since midnight. */
export function usEasternClock(at: Date): { date: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(EASTERN.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday!),
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

/** Regular trading starts at 09:30 New York time. */
export const US_SESSION_OPEN_MINUTES = 9 * 60 + 30;
/**
 * An hour past the 16:00 close, so the last sweep of the day reads the
 * closing values through a fifteen-minute delay.
 */
export const US_SESSION_READ_UNTIL_MINUTES = 17 * 60;

/**
 * Whether `at` falls on a weekday between the open and an hour after the
 * close. Exchange holidays are weekdays too and are not known here: a source
 * that can tell a holiday from its own data must check that itself.
 */
export function usEquitySessionOpen(at: Date): boolean {
  const { weekday, minutes } = usEasternClock(at);
  return weekday >= 1 && weekday <= 5 && minutes >= US_SESSION_OPEN_MINUTES && minutes < US_SESSION_READ_UNTIL_MINUTES;
}
