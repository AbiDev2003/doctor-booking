import { z } from "zod";
import type { Weekday } from "../generated/prisma/client.js";

/**
 * Day 15 request shapes — the schedule template CRUD, plan.md §11, §8.1.
 *
 * Three rules run through every schema here:
 *
 * - **No status field, ever.** `Schedule` has no `isActive` (the row's
 *   existence IS the state — schema.prisma:451-454), and slots are derived
 *   data the generator owns. A schema that accepted a slot or status input
 *   would be the client deciding server rules (§3.4).
 * - **Times are `HH:MM` strings**, the wall clock staff type. They become
 *   `@db.Time(0)` values in the service (UTC-anchored 1970-01-01 Dates), and
 *   the DB's `Time(0)` shape means `HH:MM:SS` would silently truncate anyway.
 * - **Windows are half-open `[start, end)` and never overnight**: `endTime`
 *   must be strictly after `startTime`, enforced by refine so a 20:00–09:00
 *   row cannot be entered and only discovered when the generator plans a
 *   negative-length slot.
 */

/** Path params: an id is a uuid(7); Prisma would otherwise 500 on a cast. */
export const scheduleIdParamSchema = z.object({
  id: z.uuid("Invalid schedule id"),
});

export type ScheduleIdParam = z.infer<typeof scheduleIdParamSchema>;

const weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

/** `HH:MM`, zero-padded 24-hour — the exact shape `windowsOverlap` compares as strings. */
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, e.g. 09:00");

const maxPatients = z
  .number()
  .int("must be a whole number")
  .min(1, "must be at least 1")
  .max(1000, "must not exceed 1000");

/** §20's mandatory reason, shaped once (the doctors.ts twin, same shape). */
const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(1000, "Reason must not exceed 1000 characters");

/**
 * POST /schedules — create one weekly window.
 *
 * `maxPatients` is required here: the column is NOT NULL with no default, and
 * a window without a capacity is not a bookable thing (§8.1). A DOCTOR may
 * include it on create; on PATCH it is ADMIN/STAFF-only (decision 2).
 *
 * An optional `reason` rides along for the audit row — CREATE is the one verb
 * §20/§8.4 does not mandate one for (decision 5).
 */
export const createScheduleSchema = z
  .object({
    doctorId: z.uuid("Invalid doctor id"),
    weekday,
    startTime: timeOfDay,
    endTime: timeOfDay,
    maxPatients,
    reason: reason.optional(),
  })
  .refine((window) => window.endTime > window.startTime, {
    path: ["endTime"],
    message: "endTime must be after startTime (windows cannot run overnight)",
  });

export type CreateScheduleInputShape = z.infer<typeof createScheduleSchema>;

/**
 * PATCH /schedules/:id — partial edit of one window.
 *
 * A reason is MANDATORY on update (decision 5): §20 records what moved and
 * why, and a template edit changes what patients can book. At least one field
 * must be present — `{}` is a 422, not a silent no-op (the updateDoctorSchema
 * precedent).
 *
 * The end-after-start refine is re-checked here against the PATCH's OWN
 * values; the service re-checks the merged result (a patch of only
 * `endTime: 08:00` against a 09:00 start is invalid as a merge even though
 * this schema alone would pass it).
 */
export const updateScheduleSchema = z
  .object({
    weekday: weekday.optional(),
    startTime: timeOfDay.optional(),
    endTime: timeOfDay.optional(),
    maxPatients: maxPatients.optional(),
    reason,
  })
  .refine(
    (patch) =>
      patch.weekday !== undefined ||
      patch.startTime !== undefined ||
      patch.endTime !== undefined ||
      patch.maxPatients !== undefined,
    { message: "At least one field is required" },
  )
  .refine(
    (patch) =>
      patch.startTime === undefined ||
      patch.endTime === undefined ||
      patch.endTime > patch.startTime,
    {
      path: ["endTime"],
      message: "endTime must be after startTime (windows cannot run overnight)",
    },
  );

export type UpdateScheduleInputShape = z.infer<typeof updateScheduleSchema>;

/** DELETE /schedules/:id — reason mandatory (decision 5, same §20 argument as update). */
export const deleteScheduleSchema = z.object({ reason });
export type DeleteScheduleInputShape = z.infer<typeof deleteScheduleSchema>;

/**
 * GET /schedules?doctorId=… — the list is always scoped to one doctor.
 * Requiring it keeps the endpoint from growing a "list everything" mode no
 * surface asks for; §4's "staff can view doctor schedules" is per-doctor.
 */
export const listSchedulesQuerySchema = z.object({
  doctorId: z.uuid("Invalid doctor id"),
});

export type ListSchedulesQueryShape = z.infer<typeof listSchedulesQuerySchema>;

/**
 * POST /schedules/materialize — the manual re-run of the generator.
 *
 * No body required; `{ doctorId }` scopes it to one doctor (the post-edit and
 * post-verify hook's shape). ADMIN/STAFF only at the route.
 */
export const materializeSchema = z
  .object({
    doctorId: z.uuid("Invalid doctor id").optional(),
  })
  .optional();

export type MaterializeInputShape = z.infer<typeof materializeSchema>;

/** The DTO every schedule response carries — times as `HH:MM`, the shape clients render. */
export interface ScheduleDto {
  readonly id: string;
  readonly doctorId: string;
  readonly weekday: Weekday;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients: number;
}
