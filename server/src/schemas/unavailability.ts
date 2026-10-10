import { z } from "zod";

/**
 * Day 18 request shapes — the DoctorUnavailability CRUD (plan.md §12).
 *
 * Mirrors schemas/slots.ts for the same reasons:
 *
 * - **No derived or state field.** `createdById` and the `startAt`/`endAt`
 *   instants are the service's to write (the instants are computed from the
 *   clinic's timezone, §3.2); a schema that accepted them would let a client
 *   pick the zone the cascade overlaps against.
 * - **The window is a clinic-local wall clock** — a `YYYY-MM-DD` date and
 *   `HH:MM` times — like a slot, converted once in the service through
 *   `localDateTimeToUtc` with `Clinic.timezone`.
 * - **Reason is mandatory** (§8.4's rule, which §12 inherits): a disruption
 *   that closes bookable time and can trigger refunds must say why.
 */

/** Path params: an unavailability id is a uuid(7); Prisma would otherwise 500 on a cast. */
export const unavailabilityIdParamSchema = z.object({
  id: z.uuid("Invalid unavailability id"),
});

export type UnavailabilityIdParam = z.infer<typeof unavailabilityIdParamSchema>;

/** A clinic-local `YYYY-MM-DD` calendar date. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD, e.g. 2026-10-09");

/** `HH:MM`, zero-padded 24-hour. */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, e.g. 09:00");

/** §8.4/§12's mandatory reason, shaped once (the slots.ts twin). */
const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(1000, "Reason must not exceed 1000 characters");

/**
 * POST /unavailabilities — mark one doctor unavailable over a window.
 *
 * Half-open `[start, end)` and never overnight, exactly like a slot: a window
 * ending at 14:00 and one starting at 14:00 can coexist. The service
 * re-validates `endAt > startAt` after the timezone conversion.
 */
export const createUnavailabilitySchema = z
  .object({
    doctorId: z.uuid("Invalid doctor id"),
    date,
    startTime: timeOfDay,
    endTime: timeOfDay,
    reason,
  })
  .refine((window) => window.endTime > window.startTime, {
    path: ["endTime"],
    message: "endTime must be after startTime (windows cannot run overnight)",
  });

export type CreateUnavailabilityInputShape = z.infer<typeof createUnavailabilitySchema>;

/**
 * GET /unavailabilities?doctorId=… — the management list, scoped to one doctor
 * (the slots.ts "list everything" prohibition).
 */
export const listUnavailabilitiesQuerySchema = z.object({
  doctorId: z.uuid("Invalid doctor id"),
});

export type ListUnavailabilitiesQueryShape = z.infer<typeof listUnavailabilitiesQuerySchema>;

/**
 * DELETE /unavailabilities/:id — a mandatory reason for the §20 audit row
 * (mirrors schedules.ts's delete schema: removing a bookable thing must say
 * why).
 */
export const removeUnavailabilitySchema = z.object({ reason });
export type RemoveUnavailabilityInputShape = z.infer<typeof removeUnavailabilitySchema>;

/**
 * The DTO every response carries: instants as ISO strings (an absolute
 * disruption has no single wall-clock pair to render) plus the clinic-local
 * date/window the caller sent, so a management screen can echo the input.
 */
export interface DoctorUnavailabilityDto {
  readonly id: string;
  readonly doctorId: string;
  readonly createdById: string;
  /** Clinic-local `YYYY-MM-DD` of the window's start. */
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly reason: string;
  readonly createdAt: string;
}
