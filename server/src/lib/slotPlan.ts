import type { Weekday } from "../generated/prisma/client.js";

/**
 * plan.md §11, §3.2 — the pure half of slot materialisation, Day 15.
 *
 * Everything in this module is calendar arithmetic over clinic-local DATE and
 * TIME strings. It never imports config or prisma at runtime and never calls
 * time.ts's zone conversion, which is what makes it unit-testable with no
 * environment (the Day 9 precedent: split the judgment from the I/O so the
 * judgment gets real tests; the DB-backed versions land with Day 36). The
 * `Weekday` import is `import type` — erased at compile, so the enum values
 * cannot drift from the schema while the module stays dependency-free.
 * (slotGeneration.service.ts owns the I/O around it: reading the Clinic row,
 * loading windows and existing slots, converting wall clocks to instants
 * through `localDateTimeToUtc`, and writing rows.)
 *
 * Three rules from the locked Day 15 decisions live here as code:
 *
 * - **The horizon is inclusive of today** — `[today, today + bookingHorizonDays]`,
 *   matching the seed's `daysOut > horizonDays` skip: a slot dated today is
 *   materialised even when its start time has already passed (decision 8).
 *   Whether a past-today slot is *bookable* is Day 17's read-model filter, not
 *   the generator's concern.
 * - **Idempotency is a whole-date skip (decision 1, Option A)** — a date that
 *   already has ANY slot for this doctor is skipped entirely, not merged
 *   window-by-window. The cost is the documented one: adding a window to a
 *   doctor whose horizon is already stocked only lands on dates as they roll
 *   into the horizon. Already-generated dates are corrected through Day 16's
 *   slot-edit path, per §11.
 * - **Weekday of a date is calendar arithmetic, not zone arithmetic** —
 *   `Date.UTC` over the date's own parts. A clinic-local calendar date's
 *   weekday does not depend on any instant, so no zone is needed to ask it.
 */

/** One weekly template row: a window on a weekday (§8.1). Times are `HH:MM`. */
export interface TemplateWindow {
  readonly weekday: Weekday;
  /** Clinic-local wall clock, `HH:MM`, as staff write it. */
  readonly startTime: string;
  /** Clinic-local wall clock, `HH:MM`. Must be after `startTime` — no overnight windows. */
  readonly endTime: string;
  readonly maxPatients: number;
}

/** One materialisable slot: a window pinned to a clinic-local calendar date. */
export interface PlannedSlot {
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients: number;
}

export interface PlanInput {
  readonly windows: readonly TemplateWindow[];
  /** Today as the clinic sees it, `YYYY-MM-DD` — NOT the server's calendar date. */
  readonly firstDate: string;
  readonly horizonDays: number;
  /**
   * Dates (`YYYY-MM-DD`) that already have at least one slot for this doctor.
   * Every one of them is skipped whole (decision 1).
   */
  readonly existingDates: ReadonlySet<string>;
}

export interface PlanResult {
  readonly slots: readonly PlannedSlot[];
  /** Dates inside the horizon that were skipped because slots already exist there. */
  readonly skippedExistingDates: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const WEEKDAYS_BY_JS_DAY: readonly Weekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * The `Weekday` a clinic-local calendar date falls on.
 *
 * Pure `Date.UTC` weekday arithmetic: the parts alone determine the weekday,
 * no instant and no timezone enter the calculation. Returns null for a date
 * string that is not a real `YYYY-MM-DD` — `Date.UTC` would silently roll
 * `2026-02-30` into March, and the weekday of a date that does not exist is
 * not a question worth answering loudly.
 */
export function weekdayOfDate(date: string): Weekday | null {
  const match = DATE_PATTERN.exec(date);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utc = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check: rejects 2026-02-30 and friends, which Date.UTC rolls over.
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }

  return WEEKDAYS_BY_JS_DAY[utc.getUTCDay()] ?? null;
}

/**
 * The clinic-local dates `[firstDate, firstDate + horizonDays]`, inclusive of
 * both ends, as `YYYY-MM-DD` strings.
 *
 * `firstDate + horizonDays` inclusive means a 60-day horizon yields 61 dates —
 * today plus the next 60, which is what "bookable up to 60 days ahead" means
 * from today's vantage. Calendar arithmetic via `Date.UTC`, so a string add
 * cannot depend on the host's zone; a malformed `firstDate` yields no dates
 * rather than an epoch-adjacent accident.
 */
export function enumerateDates(firstDate: string, horizonDays: number): string[] {
  if (horizonDays < 0) return [];
  const match = DATE_PATTERN.exec(firstDate);
  if (match === null) return [];

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const start = Date.UTC(year, month - 1, day);
  // Round-trip check like weekdayOfDate: Date.UTC would silently turn
  // 2026-02-30 into 2026-03-02, and an enumeration anchored on a date that
  // never existed is a silent tilt of everything downstream.
  if (
    Number.isNaN(start) ||
    new Date(start).getUTCFullYear() !== year ||
    new Date(start).getUTCMonth() !== month - 1 ||
    new Date(start).getUTCDate() !== day
  ) {
    return [];
  }

  const dates: string[] = [];
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    dates.push(new Date(start + offset * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Every slot the template implies for one doctor inside the horizon, minus the
 * dates already stocked (decision 1).
 *
 * Dates iterate ascending and windows within a date keep template order, so
 * the output is deterministic — a re-run with the same inputs plans the same
 * rows in the same order, which is what makes the createMany backstop's
 * `skipDuplicates` a race net rather than a reshuffle.
 */
export function planSlotsForDoctor(input: PlanInput): PlanResult {
  const dates = enumerateDates(input.firstDate, input.horizonDays);
  const slots: PlannedSlot[] = [];
  let skippedExistingDates = 0;

  for (const date of dates) {
    if (input.existingDates.has(date)) {
      skippedExistingDates += 1;
      continue;
    }

    const weekday = weekdayOfDate(date);
    if (weekday === null) continue;

    for (const window of input.windows) {
      if (window.weekday !== weekday) continue;
      slots.push({
        date,
        startTime: window.startTime,
        endTime: window.endTime,
        maxPatients: window.maxPatients,
      });
    }
  }

  return { slots, skippedExistingDates };
}

/**
 * Do two windows on the same weekday collide? Half-open `[start, end)`
 * intervals: adjacent windows (09:00–12:00 and 12:00–15:00) do NOT overlap,
 * an identical window does, and containment does.
 *
 * String comparison is chronological here because both times are zero-padded
 * `HH:MM` from the same fixed-width shape the schema admits — "09:00" < "12:00"
 * as strings exactly when it is earlier as a clock reading.
 */
export function windowsOverlap(
  a: { readonly startTime: string; readonly endTime: string },
  b: { readonly startTime: string; readonly endTime: string },
): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}
