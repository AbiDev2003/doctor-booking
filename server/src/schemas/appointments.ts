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
 * Day 22 request shape — §14's reschedule.
 *
 * The body carries the TARGET slot and nothing else that matters: the
 * appointment is the path param and the actor is `req.user`, so neither the
 * current slot, the doctor, the fee nor the status is client-supplied (the same
 * §3.4 rule as Day 19's booking). `reason` is optional at the schema because a
 * patient's own move needs none; the service is where STAFF/ADMIN's mandatory
 * reason is enforced, since the schema cannot see who is calling.
 */
export const rescheduleAppointmentSchema = z.object({
  slotId: z.uuid("Invalid slot id"),
  reason: reason.optional(),
});

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

/**
 * Day 30 — the patient dashboard's read surface. A patient sees only their own
 * rows; `scope` is a presentation filter over the same query (the server still
 * sorts and decides what "upcoming" means against the slot's UTC instant, not
 * the browser's clock).
 */
export const listAppointmentsQuerySchema = z.object({
  scope: z.enum(["upcoming", "past", "all"]).default("all"),
});

export type ListAppointmentsScope = z.infer<typeof listAppointmentsQuerySchema>["scope"];

/**
 * The appointment a patient dashboard renders. It extends the booking DTO with
 * the slot's absolute instants (so the client can sort across timezones) and the
 * two eligibility flags the actions depend on — computed server-side because
 * only the server knows the clinic's cutoff, the appointment status and whether
 * the slot was clinic-caused.
 */
export interface PatientAppointmentDto extends AppointmentDto {
  /** UTC instant of the slot's start. */
  readonly slotStartsAt: string;
  /** UTC instant of the slot's end. */
  readonly slotEndsAt: string;
  /** True when the §12 disruption marker is set (waives the cutoff, §8.5). */
  readonly clinicCaused: boolean;
  /** CONFIRMED + before the §8.5 cutoff (+ clinic-caused waiver). */
  readonly canCancel: boolean;
  /** CONFIRMED + the same cutoff window (a patient may only move to the same doctor, §14). */
  readonly canReschedule: boolean;
  /** Human reason when `canCancel` is false, null otherwise. */
  readonly cancelBlockedReason: string | null;
}

/**
 * The cancellation confirmation's server-side answer: whether the action is
 * allowed now and exactly what money follows. The client must not re-derive
 * this from status + dates (§33/§17), or a copy drift could promise a refund the
 * server will not make.
 */
export interface CancellationPreviewDto {
  readonly appointmentId: string;
  readonly canCancel: boolean;
  readonly cancelBlockedReason: string | null;
  readonly clinicCaused: boolean;
  readonly slotStartsAt: string;
  /** `slotStartsAt − cancelCutoffMinutes`; the clinic-caused waiver still starts at the slot. */
  readonly cutoffAt: string | null;
  /** The latest PAID payment, or a PENDING pay-at-clinic receivable. */
  readonly payment: {
    readonly id: string;
    readonly amountPaise: number;
    readonly status: $Enums.PaymentStatus;
    readonly method: $Enums.PaymentMethod | null;
  } | null;
  /** Money the patient gets back; 0 for a free, unpaid or settled-by-void booking. */
  readonly refundAmountPaise: number;
  /** `automatic` = gateway/worker settles; `desk` = a human returns cash/UPI; `none` = nothing to return. */
  readonly refundSettlement: "automatic" | "desk" | "none";
}
