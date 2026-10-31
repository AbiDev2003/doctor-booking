/**
 * Clinic-local date helpers for the dashboard (Day 30). The server sends
 * `slotDate` as `YYYY-MM-DD` and times as `HH:MM` in the clinic's own timezone
 * (§3.2), so everything here formats those wall-clock strings without ever
 * converting them through the browser's timezone.
 */

/** Today's calendar date in `timeZone`, as `YYYY-MM-DD`. */
export function clinicToday(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

/** `date` shifted by `days` calendar days, as `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** "Mon, 3 Nov 2026" from the clinic-local `YYYY-MM-DD` (formatted in UTC). */
export function formatSlotDate(date: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** "10:00–10:30" from the clinic-local `HH:MM(:SS)` strings. */
export function formatTimeRange(start: string, end: string): string {
  return `${start.slice(0, 5)}–${end.slice(0, 5)}`;
}
