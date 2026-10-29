import { z } from "zod";
import type { $Enums } from "../generated/prisma/client.js";
import type { AppointmentDto } from "./appointments.js";

/**
 * plan.md §16/§29 — the front desk's request and response shapes (Day 32).
 *
 * Two rules shape everything here:
 *
 * - **The desk is a trusted operator, but not an author of server facts.** A
 *   booking body carries the slot and the patient's identity; the fee, doctor,
 *   status, capacity decision and booking time are derived inside the service,
 *   exactly like Day 19's patient self-booking.
 * - **The desk needs contact details the doctor's queue masks.** §28 masks a
 *   patient's phone for the doctor; the front desk's job is calling the patient
 *   back, so its queue carries the full E.164 value. Both DTOs are staff-only
 *   surfaces, and the route gate is the security boundary.
 */

/** A clinic-local `YYYY-MM-DD` calendar date. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD, e.g. 2026-10-09");

/** GET /appointments/desk?date=… — defaults to the clinic's today when omitted. */
export const deskQueueQuerySchema = z.object({
  date: date.optional(),
});

export type DeskQueueQueryShape = z.infer<typeof deskQueueQuerySchema>;

/**
 * The identity the desk types at the counter. `phone` is the search key
 * (§16: normalized, unique) and the only field used to decide "new or
 * returning"; `fullName` is captured on a first visit and never overwrites an
 * existing patient's name. `email` is optional — a provisional patient may have
 * no address at all, which is why `User.email` is nullable.
 */
export const deskPatientSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "Full name is required")
    .max(200, "Full name must not exceed 200 characters"),
  phone: z
    .string()
    .trim()
    .min(1, "Phone number is required")
    .max(32, "Phone number must not exceed 32 characters"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address")
    .optional(),
});

export type DeskPatientInputShape = z.infer<typeof deskPatientSchema>;

/** POST /appointments/desk — create-or-find the patient, then claim a seat. */
export const createDeskBookingSchema = z.object({
  slotId: z.uuid("Invalid slot id"),
  patient: deskPatientSchema,
});

export type CreateDeskBookingShape = z.infer<typeof createDeskBookingSchema>;

/** GET /patients/visit-history?phone=… — the §16 returning-patient lookup. */
export const visitHistoryQuerySchema = z.object({
  phone: z
    .string()
    .trim()
    .min(1, "Phone number is required")
    .max(32, "Phone number must not exceed 32 characters"),
});

export type VisitHistoryQueryShape = z.infer<typeof visitHistoryQuerySchema>;

/** The patient as the desk sees them. */
export interface DeskPatientDto {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  /** True for a desk-created walk-in record (§16). */
  readonly isProvisional: boolean;
}

/** What the desk needs to know about money already attached to a booking. */
export interface DeskPaymentSummary {
  /** `PENDING` wins when both an outstanding and a paid row exist (a top-up). */
  readonly status: "PENDING" | "PAID" | "NONE";
  readonly outstandingPaise: number;
  readonly paidPaise: number;
  /** The latest PAID row's method, for a "collected as cash" hint. */
  readonly method: $Enums.PaymentMethod | null;
}

/**
 * The server's answer to "which attendance verbs are open right now".
 *
 * These are computed from the same pure guards the transition services apply
 * (`assertTransition`, `assertArrivalAllowed`, `assertNoShowAllowed`,
 * `assertNoPendingPayment`), so the buttons and the transactions cannot drift
 * apart as the clock moves.
 */
export interface DeskAppointmentActions {
  readonly canArrive: boolean;
  readonly canComplete: boolean;
  readonly canNoShow: boolean;
  readonly canReject: boolean;
  readonly canCancel: boolean;
  readonly canReschedule: boolean;
  readonly arriveBlockedReason: string | null;
  readonly completeBlockedReason: string | null;
  readonly noShowBlockedReason: string | null;
  readonly cancelBlockedReason: string | null;
  readonly rescheduleBlockedReason: string | null;
}

/** One booking in the staff queue or the visit-history panel. */
export interface DeskAppointmentEntry extends AppointmentDto, DeskAppointmentActions {
  readonly patient: DeskPatientDto;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  readonly payment: DeskPaymentSummary;
}

/** One of today's windows, with its queue (possibly empty). */
export interface DeskSlotQueue {
  readonly slotId: string;
  readonly doctorId: string;
  readonly doctorName: string;
  readonly slotDate: string;
  /** Clinic-local `HH:MM`. */
  readonly startTime: string;
  readonly endTime: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly maxPatients: number;
  readonly bookedCount: number;
  readonly heldCount: number;
  readonly isDisabled: boolean;
  readonly appointments: readonly DeskAppointmentEntry[];
}

export interface DeskQueueDto {
  readonly date: string;
  readonly slots: readonly DeskSlotQueue[];
}

/** The appointment-plus-patient answer a desk booking creates. */
export interface DeskBookingResult {
  readonly appointment: AppointmentDto;
  readonly patient: DeskPatientDto;
  /** True when this call created the provisional patient row. */
  readonly createdPatient: boolean;
}

/** The returning-patient summary §16 defines. */
export interface PatientSummaryDto extends DeskPatientDto {
  readonly isDeactivated: boolean;
  readonly createdAt: string;
}

export interface VisitHistoryDto {
  /** False for a phone the clinic has never seen; the UI offers "new walk-in". */
  readonly found: boolean;
  readonly patient: PatientSummaryDto | null;
  /** Has ≥ 1 COMPLETED appointment (§16). */
  readonly returning: boolean;
  readonly completedCount: number;
  readonly noShowCount: number;
  readonly upcomingCount: number;
  /** Clinic-local `YYYY-MM-DD` of the most recent COMPLETED visit. */
  readonly lastVisitDate: string | null;
  readonly doctorsSeen: readonly string[];
  readonly upcomingAppointments: readonly DeskAppointmentEntry[];
}
