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
