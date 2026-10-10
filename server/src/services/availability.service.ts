import { prisma } from "../lib/prisma.js";
import { localDateTimeToUtc, utcToLocalDateTime } from "../lib/time.js";
import {
  isSlotBookable,
  isWithinHorizon,
  remainingSeats,
} from "../lib/availability.js";
import type { BookabilityContext } from "../lib/availability.js";
import { getClinicSettings } from "./clinic.service.js";
import { assertBookableDoctor } from "./public.service.js";

/**
 * plan.md §11 — the public read-only "bookable slots for doctor X on date D"
 * surface, Day 17.
 *
 * The thin I/O shell around the pure predicate in `lib/availability.ts`: it
 * loads the doctor (404 if not bookable, via the same §5 rule the public site
 * uses), the clinic tunables, the day's slots and the disruptions that touch
 * the day, then lets `isSlotBookable` do the judging. Everything time-related
 * goes through `lib/time.ts` — the query date is a clinic-local calendar day
 * (§3.2), so "today" and the horizon come from `utcToLocalDateTime(now,
 * zone)`, never the server's own day.
 *
 * This is a read model only. It deliberately does NOT re-count live
 * appointments or holds: the stored counters are enough to avoid showing an
 * obviously-full slot, and Day 19's booking transaction is where the
 * authoritative re-check lives (§8.6). See `lib/availability.ts` for why the
 * counters' staleness can only ever hide a slot, never show a booked one.
 *
 * A date outside `[today, today + horizon]` is an EMPTY list, not an error
 * (locked decision 6): it is a legitimate answer to "are there slots then" —
 * there are none — and it keeps the client's date input bounded by the same
 * horizon the server enforces.
 */

export interface AvailableSlot {
  readonly slotId: string;
  /** Clinic-local `YYYY-MM-DD` — the date the caller asked about. */
  readonly slotDate: string;
  /** Clinic-local `HH:MM` wall clock (the display value). */
  readonly startTime: string;
  readonly endTime: string;
  /** Free seats per the stored counters — a UX hint, floored at zero. */
  readonly remaining: number;
}

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` a client renders. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/** `@db.Date` write value: the clinic-local calendar date as a UTC midnight. */
function dateValue(date: string): Date {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

/** One calendar day later, as a `YYYY-MM-DD` string (proleptic UTC, DST-safe). */
function nextDate(date: string): string {
  return addDays(date, 1);
}

/** `date` shifted by `days` calendar days, as `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month, day + days)).toISOString().slice(0, 10);
}

export async function listDoctorAvailability(
  doctorId: string,
  date: string,
  now: Date = new Date(),
): Promise<AvailableSlot[]> {
  const clinic = await getClinicSettings();
  await assertBookableDoctor(doctorId);

  const today = utcToLocalDateTime(now, clinic.timezone).date;
  const horizon = { earliestDate: today, latestDate: addDays(today, clinic.bookingHorizonDays) };

  // Locked decision 6: outside the horizon there is nothing to show — empty,
  // not an error. Short-circuit before touching the slot tables.
  if (!isWithinHorizon(date, horizon)) {
    return [];
  }

  // The instants bounding the requested clinic-local day, so the unavailability
  // read is scoped to disruptions that could touch this date at all.
  const dayStart = localDateTimeToUtc({ date, time: "00:00:00" }, clinic.timezone);
  const dayEnd = localDateTimeToUtc({ date: nextDate(date), time: "00:00:00" }, clinic.timezone);

  const [slots, unavailabilities] = await Promise.all([
    prisma.slot.findMany({
      where: { doctorId, slotDate: dateValue(date) },
      orderBy: { startTime: "asc" },
      select: {
        id: true,
        slotDate: true,
        startTime: true,
        endTime: true,
        startAt: true,
        endAt: true,
        isDisabled: true,
        maxPatients: true,
        bookedCount: true,
        heldCount: true,
      },
    }),
    prisma.doctorUnavailability.findMany({
      where: { doctorId, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      select: { startAt: true, endAt: true },
    }),
  ]);

  const context: BookabilityContext = {
    now,
    minLeadMinutes: clinic.minLeadMinutes,
    horizon,
    unavailabilities,
  };

  return slots
    .filter((slot) =>
      isSlotBookable(
        {
          slotDate: slot.slotDate.toISOString().slice(0, 10),
          startAt: slot.startAt,
          endAt: slot.endAt,
          isDisabled: slot.isDisabled,
          maxPatients: slot.maxPatients,
          bookedCount: slot.bookedCount,
          heldCount: slot.heldCount,
        },
        context,
      ),
    )
    .map((slot) => ({
      slotId: slot.id,
      slotDate: date,
      startTime: hhmm(slot.startTime),
      endTime: hhmm(slot.endTime),
      remaining: remainingSeats(slot),
    }));
}
