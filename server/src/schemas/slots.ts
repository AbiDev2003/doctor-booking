import { z } from "zod";

/**
 * Day 16 request shapes — the dated Slot CRUD (§8.4) and the clinic settings
 * surface (§3.2).
 *
 * Three rules run through every schema here (mirroring schemas/schedules.ts):
 *
 * - **No counter or status field, ever.** `bookedCount`, `heldCount`,
 *   `isDisabled` and `disabledReason` are properties of the slot row, owned by
 *   the service and the §8.4 guards; a schema that accepted them would be the
 *   client deciding server rules (§3.4). Disabling is its own verb with its
 *   own mandatory reason, not a boolean on an edit.
 * - **Times are `HH:MM` strings**, the wall clock staff type, and `slotDate`
 *   is a `YYYY-MM-DD` clinic-local calendar date — both become real columns
 *   in the service (matching the generator's `timeValue`/`dateValue` shapes).
 * - **Windows are half-open `[start, end)` and never overnight**:
 *   `endTime` must be strictly after `startTime`, so an edit cannot quietly
 *   produce a negative-length slot.
 */

/** Path params: a slot id is a uuid(7); Prisma would otherwise 500 on a cast. */
export const slotIdParamSchema = z.object({
  id: z.uuid("Invalid slot id"),
});

export type SlotIdParam = z.infer<typeof slotIdParamSchema>;

/** A clinic-local `YYYY-MM-DD` calendar date. */
export const slotDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD, e.g. 2026-10-09");

/** `HH:MM`, zero-padded 24-hour — the exact shape the guard compares as strings. */
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, e.g. 09:00");

const maxPatients = z
  .number()
  .int("must be a whole number")
  .min(1, "must be at least 1")
  .max(1000, "must not exceed 1000");

/** §8.4's mandatory reason, shaped once (the schedules.ts twin, same shape). */
const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(1000, "Reason must not exceed 1000 characters");

/**
 * POST /slots — create one dated slot manually.
 *
 * Reason is OPTIONAL on create (decision 2, mirroring schedules): creating a
 * slot is not an "edit" under §8.4, which mandates a reason on every *change*.
 * A DOCTOR may not create a slot at all — decision 1 keeps slot permission to
 * ADMIN/STAFF.
 */
export const createSlotSchema = z
  .object({
    doctorId: z.uuid("Invalid doctor id"),
    slotDate,
    startTime: timeOfDay,
    endTime: timeOfDay,
    maxPatients,
    reason: reason.optional(),
  })
  .refine((slot) => slot.endTime > slot.startTime, {
    path: ["endTime"],
    message: "endTime must be after startTime (windows cannot run overnight)",
  });

export type CreateSlotInputShape = z.infer<typeof createSlotSchema>;

/**
 * PATCH /slots/:id — a partial edit of one slot.
 *
 * The seat-or-hold guard and the capacity-lower guard are the service's job;
 * this schema's jobs are the §8.4 reason (MANDATORY on every edit) and "not an
 * empty `{}` patch" (the updateScheduleSchema precedent). `slotDate`,
 * `startTime`/`endTime` may move TOGETHER or alone — a date-only edit is a
 * time edit for the §8.4 guard, and touching any of the three makes the whole
 * request a "time edit", which is refused when a seat or live hold exists
 * (decision 3). The end-after-start refine is checked against the PATCH's OWN
 * pair; the service re-checks the merged result.
 */
export const updateSlotSchema = z
  .object({
    slotDate: slotDate.optional(),
    startTime: timeOfDay.optional(),
    endTime: timeOfDay.optional(),
    maxPatients: maxPatients.optional(),
    reason,
  })
  .refine(
    (patch) =>
      patch.slotDate !== undefined ||
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

export type UpdateSlotInputShape = z.infer<typeof updateSlotSchema>;

/**
 * POST /slots/:id/disable and /enable — the audited availability split of the
 * day-slot surface (decision 7). Reason is MANDATORY on both: disabling is an
 * edit under §8.4, and re-enabling is "an explicit audited action with a
 * reason" (schema.prisma:502).
 */
export const slotDisableSchema = z.object({ reason });
export type SlotDisableInputShape = z.infer<typeof slotDisableSchema>;

export const slotEnableSchema = z.object({ reason });
export type SlotEnableInputShape = z.infer<typeof slotEnableSchema>;

/**
 * GET /slots?doctorId=…&slotDate=… — staff/admin management list, scoped to a
 * doctor (a "list everything" mode is the kind of unrequested surface §3.4
 * warns about). `slotDate` narrows to one clinic-local day when given.
 */
export const listSlotsQuerySchema = z.object({
  doctorId: z.uuid("Invalid doctor id"),
  slotDate: slotDate.optional(),
});

export type ListSlotsQueryShape = z.infer<typeof listSlotsQuerySchema>;

/**
 * The DTO every slot response carries — times as `HH:MM` and the date as
 * `YYYY-MM-DD`, the shapes clients render, plus the counters and availability
 * state so the staff screen can show why an edit is refused.
 */
export interface SlotDto {
  readonly id: string;
  readonly doctorId: string;
  readonly slotDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients: number;
  readonly bookedCount: number;
  readonly heldCount: number;
  readonly isDisabled: boolean;
  readonly disabledReason: string | null;
  readonly startAt: string;
  readonly endAt: string;
}