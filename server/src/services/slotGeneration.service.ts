import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { localDateTimeToUtc, utcToLocalDateTime } from "../lib/time.js";
import { logger } from "../lib/logger.js";
import { planSlotsForDoctor } from "../lib/slotPlan.js";
import type { TemplateWindow } from "../lib/slotPlan.js";
import { getClinicSettings } from "./clinic.service.js";

/**
 * plan.md §11, §10, §3.2 — materialising dated Slots from a weekly template,
 * Day 15.
 *
 * The generator is the write half of §11: for every bookable doctor, every
 * template window is turned into one `Slot` row per clinic-local date inside
 * `[today, today + bookingHorizonDays]` (inclusive of today, decision 8 —
 * whether today's elapsed windows are *bookable* is Day 17's filter, not
 * this function's).
 *
 * **Idempotency is the whole-date skip, then `skipDuplicates` (decision 1).**
 * A date that already carries ANY slot for the doctor is skipped wholesale —
 * template edits therefore apply only to not-yet-generated dates, exactly as
 * §11 requires, and already-generated slots are corrected through Day 16's
 * slot-edit path rather than silently regenerated. The unique key
 * `(doctorId, slotDate, startTime)` plus `createMany({ skipDuplicates: true })`
 * is the race net underneath: two concurrent runs (or a run racing a manual
 * slot create) both plan the same rows and the database keeps one of each.
 *
 * **Bookable means §5's rule, applied as a WHERE** — `VERIFIED AND
 * suspendedAt IS NULL` — the same two columns `isBookable` reads. A suspended
 * or unverified doctor's template is untouched; when they are verified or
 * un-suspended, `verifyDoctor`/`unsuspendDoctor` re-invoke this function and
 * the horizon fills in one pass (§5.2's "materialisation resumes").
 *
 * **Every instant goes through `localDateTimeToUtc` (§3.2).** A window whose
 * wall clock does not exist in the clinic's zone (the spring-forward gap) is
 * skipped and logged, never written as an invented instant — the §3.2 rule,
 * and the reason the zone comes from the Clinic row rather than the host or
 * the env var.
 *
 * No audit rows: a materialised slot is derived data, not a human action
 * (locked decision 6). The Pino log line per run is the record. Template CRUD
 * itself IS audited — see schedule.service.ts.
 */
export interface MaterializeStats {
  /** Doctors considered — bookable, with or without templates. */
  readonly doctors: number;
  /** Slot rows actually inserted (skipDuplicates may drop raced duplicates). */
  readonly created: number;
  /** Dates skipped because slots already existed there (decision 1). */
  readonly skippedExistingDates: number;
  /** Windows skipped because their wall clock does not exist in the clinic zone (§3.2). */
  readonly rejectedWindows: number;
}

const EMPTY_STATS: MaterializeStats = {
  doctors: 0,
  created: 0,
  skippedExistingDates: 0,
  rejectedWindows: 0,
};

export interface MaterializeOptions {
  /**
   * Limit to one doctor — the post-verify/post-unsuspend hook and the
   * post-template-edit hook pass this. Absent: every bookable doctor, which
   * is what the manual re-run endpoint and a future interval job (Day 29) do.
   */
  readonly doctorId?: string | undefined;
}

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` the planner speaks. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/** `@db.Time(0)` write value: UTC-anchored 1970-01-01, matching the seed's `timeOf`. */
function timeValue(time: string): Date {
  const [hour = "0", minute = "0"] = time.split(":");
  return new Date(Date.UTC(1970, 0, 1, Number(hour), Number(minute), 0));
}

/** `@db.Date` write value: the clinic-local calendar date as a UTC midnight. */
function dateValue(date: string): Date {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

export async function materializeSlots(options: MaterializeOptions = {}): Promise<MaterializeStats> {
  const clinic = await getClinicSettings();
  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;

  const doctors = await prisma.user.findMany({
    where: {
      role: $Enums.UserRole.DOCTOR,
      ...(options.doctorId !== undefined && { id: options.doctorId }),
      doctorProfile: {
        verificationStatus: $Enums.DoctorVerificationStatus.VERIFIED,
        suspendedAt: null,
      },
    },
    select: {
      id: true,
      fullName: true,
      schedules: {
        select: { weekday: true, startTime: true, endTime: true, maxPatients: true },
        orderBy: { startTime: "asc" },
      },
    },
    // An explicitly-targeted doctor who is not bookable reads as zero rows —
    // correct by construction: the WHERE above IS §5's rule, and materialising
    // for a suspended doctor would contradict every other reader.
  });

  if (doctors.length === 0) {
    return EMPTY_STATS;
  }

  let created = 0;
  let skippedExistingDates = 0;
  let rejectedWindows = 0;

  for (const doctor of doctors) {
    const windows: TemplateWindow[] = doctor.schedules.map((schedule) => ({
      weekday: schedule.weekday,
      startTime: hhmm(schedule.startTime),
      endTime: hhmm(schedule.endTime),
      maxPatients: schedule.maxPatients,
    }));

    if (windows.length === 0) continue;

    // Dates inside the horizon that already carry slots. Bounded to the
    // horizon window so a long-stocked doctor does not ship its whole history
    // through memory just to be told "all present".
    const lastDate = new Date(
      Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + clinic.bookingHorizonDays),
    )
      .toISOString()
      .slice(0, 10);

    const existing = await prisma.slot.findMany({
      where: {
        doctorId: doctor.id,
        slotDate: { gte: dateValue(today), lte: dateValue(lastDate) },
      },
      select: { slotDate: true },
      distinct: ["slotDate"],
    });

    const existingDates = new Set(existing.map((slot) => slot.slotDate.toISOString().slice(0, 10)));

    const plan = planSlotsForDoctor({
      windows,
      firstDate: today,
      horizonDays: clinic.bookingHorizonDays,
      existingDates,
    });
    skippedExistingDates += plan.skippedExistingDates;

    const rows: {
      doctorId: string;
      slotDate: Date;
      startTime: Date;
      endTime: Date;
      startAt: Date;
      endAt: Date;
      maxPatients: number;
    }[] = [];

    for (const planned of plan.slots) {
      try {
        rows.push({
          doctorId: doctor.id,
          slotDate: dateValue(planned.date),
          startTime: timeValue(planned.startTime),
          endTime: timeValue(planned.endTime),
          startAt: localDateTimeToUtc({ date: planned.date, time: planned.startTime }, clinic.timezone),
          endAt: localDateTimeToUtc({ date: planned.date, time: planned.endTime }, clinic.timezone),
          maxPatients: planned.maxPatients,
        });
      } catch (error) {
        // §3.2: a nonexistent local time is skipped and logged, never written.
        // The rest of the doctor's windows still land — one DST gap must not
        // cost the whole day.
        if (error instanceof AppError && error.code === "NONEXISTENT_LOCAL_TIME") {
          rejectedWindows += 1;
          logger.warn(
            { doctorId: doctor.id, date: planned.date, startTime: planned.startTime, timezone: clinic.timezone },
            "slot window skipped — wall clock does not exist in the clinic timezone (§3.2)",
          );
          continue;
        }
        throw error;
      }
    }

    if (rows.length === 0) continue;

    const result = await prisma.slot.createMany({ data: rows, skipDuplicates: true });
    created += result.count;
  }

  const stats: MaterializeStats = { doctors: doctors.length, created, skippedExistingDates, rejectedWindows };

  logger.info(
    {
      timezone: clinic.timezone,
      horizonDays: clinic.bookingHorizonDays,
      scopedTo: options.doctorId ?? null,
      ...stats,
    },
    "slot materialisation complete",
  );

  return stats;
}
