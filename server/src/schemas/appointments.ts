import { z } from "zod";
import type { $Enums } from "../generated/prisma/client.js";

/**
 * Day 19 request shapes — creating a booking (§8.1, §13, §15).
 *
 * The one rule that matters here: **the client sends a slot id and nothing
 * else.** No `patientId` (that is the authenticated actor, never the body), no
 * `status` (an appointment is born `CONFIRMED`, §13), no `doctorId` or fee
 * (both are read off the slot and the doctor inside the transaction, so the
 * client cannot pick its own price — §3.4). Everything the transaction needs is
 * derived server-side.
 */

export const createBookingSchema = z.object({
  slotId: z.uuid("Invalid slot id"),
});

export type CreateBookingInputShape = z.infer<typeof createBookingSchema>;

/**
 * Day 21 request shapes — the §13/§13.1 status transitions.
 *
 * Arriving a patient and marking them seen or absent carry NO body: the target status is the route's verb, and the actor is `req.user`. The two staff actions that §13/§8.5 make reason-mandatory — rejecting a booking and cancelling one — carry a `reason`, shaped once here (the `slots.ts`/`unavailability.ts` twin).
 * A patient cancelling their own booking needs no reason; the service enforces the staff-only requirement, because the schema cannot know who is calling.
 */
export const appointmentIdParamSchema = z.object({
  id: z.uuid("Invalid appointment id"),
});

const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(1000, "Reason must not exceed 1000 characters");

/** POST /:id/reject — §13's `REJECTED`; reason MANDATORY (§13, §18). */
export const rejectAppointmentSchema = z.object({ reason });

/** POST /:id/cancel — reason optional so a patient may cancel; staff must supply one (service-enforced). */
export const cancelAppointmentSchema = z.object({ reason: reason.optional() });

/**
 * The appointment a booking returns. Times are the clinic-local `HH:MM` wall
 * clock and `YYYY-MM-DD` date the client renders (the `AvailableSlot` twin in
 * `availability.service.ts`), plus the booking-time snapshots (`doctorName`,
 * `feeAmount`, `bookingTime`) exactly as stored — a later rename or fee change
 * never rewrites what the patient saw.
 */
export interface AppointmentDto {
  readonly id: string;
  readonly doctorId: string;
  readonly doctorName: string;
  readonly patientId: string;
  readonly slotId: string;
  /** Clinic-local `YYYY-MM-DD`. */
  readonly slotDate: string;
  /** Clinic-local `HH:MM`. */
  readonly startTime: string;
  readonly endTime: string;
  readonly status: $Enums.AppointmentStatus;
  /** Paise, snapshotted at booking time. */
  readonly feeAmount: number;
  readonly bookingTime: string;
  readonly createdAt: string;
}
