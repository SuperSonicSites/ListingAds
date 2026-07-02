// Business-date helpers. All workflow date logic (due badges, reminders, the
// "Happy {DAY}!" greeting, the send-window banner) runs in America/Vancouver —
// the "9-5pm PST" business hours from the spec. format.ts (UTC) stays for
// display-only timestamps.
const ZONE = "America/Vancouver";

const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }); // YYYY-MM-DD
const weekdayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, weekday: "long" });
const hourFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  hour: "numeric",
  hour12: false
});

/** Today's date as YYYY-MM-DD in America/Vancouver. */
export function vancouverToday(): string {
  return dayFormatter.format(new Date());
}

/** "Monday" ... "Sunday", in America/Vancouver — for "Happy {DAY}!". */
export function vancouverWeekday(): string {
  return weekdayFormatter.format(new Date());
}

/** Mon–Fri 09:00–16:59 in America/Vancouver (the spec's 9-5pm PST send window). */
export function isBusinessHours(now = new Date()): boolean {
  const weekday = weekdayFormatter.format(now);
  if (weekday === "Saturday" || weekday === "Sunday") return false;
  const hour = Number(hourFormatter.format(now));
  return hour >= 9 && hour < 17;
}

/** Add days to a YYYY-MM-DD date (pure calendar math, no timezone involved). */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (YYYY-MM-DD each); negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
