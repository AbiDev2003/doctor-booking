import { z } from "zod";

/**
 * Day 32 + Day 34: the front desk's input shapes, shared with the browser.
 *
 * The desk is a trusted operator, but not an author of server facts: a booking
 * body carries the slot and the patient's identity; fee, doctor, status,
 * capacity and booking time are derived inside the service.
 */

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

/**
 * Day 34: staff attach a real address to a provisional walk-in record, giving
 * the patient a way to sign in later without inventing a second account.
 */
export const attachPatientEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
});

export type AttachPatientEmailInputShape = z.infer<typeof attachPatientEmailSchema>;
