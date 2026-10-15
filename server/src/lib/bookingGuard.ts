import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "./appError.js";
import { hasStarted, isWithinHorizon, overlapsUnavailability } from "./availability.js";
import type { BookabilityContext, BookabilitySlot } from "./availability.js";

/**
 * plan.md §15 — the pure judgment behind a booking, Day 19.
 *
 * Split from the I/O for the same reason `doctorState.ts`, `slotGuard.ts` and
 * `availability.ts` are: every decision here is a property of inputs the
 * service has already fetched inside its own transaction, so it is unit-testable
 * without a database (`tests/bookingGuard.test.ts`), while the DB-backed race
 * belongs to the DoD script and Day 20's harness.
 *
 * Day 17's `isSlotBookable` answers "may this be SHOWN as bookable" and
 * deliberately reads stale counters. This file answers the stricter question
 * "may this seat be CONSUMED now" — but even here, the capacity decision is NOT
 * made by re-reading counters: it is made by the atomic guarded `UPDATE … WHERE
 * booked_count + held_count < max_patients` (§15), whose row count is the only
 * authoritative answer. So `assertSlotBookableForBooking` judges the five
 * non-capacity conditions and the service lets the guarded update judge the
 * sixth (fullness → `SLOT_FULL`). A stale counter that is too high must never
 * refuse a seat that is actually free.
 *
 * Every refusal is an `AppError` with a specific code so a legitimate client can
 * branch without parsing prose.
 */

/**
 * The statuses that count against §15's per-patient cap and the same-slot
 * partial unique index: **CONFIRMED and ARRIVED only**. This is deliberately
 * narrower than `SEAT_HOLDING_STATUSES` (`slotGuard.ts`), which additionally
 * includes COMPLETED/NO_SHOW until the window ends (§13.1) because those still
 * occupy a seat. Those two do NOT block the same patient from a new booking:
 * their seat is spent, not promised, so a second booking on an already-ended
 * window is a legitimate re-visit, not a double-booking.
 */
export const ACTIVE_BOOKING_STATUSES = [
  $Enums.AppointmentStatus.CONFIRMED,
  $Enums.AppointmentStatus.ARRIVED,
] as const;

/**
 * §15's per-patient cap: `activeBookings + activeHolds < maxActiveBookingsPerPatient`.
 * Both numbers are read inside the caller's transaction while holding the
 * patient's row lock, so two concurrent attempts by one patient cannot both pass.
 */
export function assertPatientSeatCap(activeSeats: number, maxActiveBookingsPerPatient: number): void {
  if (activeSeats >= maxActiveBookingsPerPatient) {
    throw new AppError(
      409,
      "BOOKING_CAP_REACHED",
      `You already have ${activeSeats} active ${activeSeats === 1 ? "booking" : "bookings"} — the limit is ${maxActiveBookingsPerPatient}. Cancel one before booking another.`,
      { activeSeats, maxActiveBookingsPerPatient },
    );
  }
}

/**
 * §15's same-slot rule, the clean 409 in front of the partial unique index. The
 * index remains the guarantee; this is the answer a legitimate client can read.
 */
export function assertNoDuplicateForSlot(alreadyBooked: boolean): void {
  if (alreadyBooked) {
    throw new AppError(409, "ALREADY_BOOKED", "You already have a booking for this slot.");
  }
}

/**
 * The non-capacity §5/§8.5/§10/§11 conditions, re-checked against live rows
 * inside the booking transaction. Order is by specificity: the slot's own state
 * first, then the clock, then the horizon, then the doctor's disruptions.
 */
export function assertSlotBookableForBooking(slot: BookabilitySlot, context: BookabilityContext): void {
  if (slot.isDisabled) {
    throw new AppError(409, "SLOT_DISABLED", "This slot is not available for booking.");
  }
  if (hasStarted(slot, context.now, context.minLeadMinutes)) {
    throw new AppError(409, "SLOT_STARTED", "This slot has already started.");
  }
  if (!isWithinHorizon(slot.slotDate, context.horizon)) {
    throw new AppError(422, "BOOKING_OUTSIDE_HORIZON", "This slot is outside the clinic's booking window.");
  }
  if (overlapsUnavailability(slot, context.unavailabilities)) {
    throw new AppError(409, "DOCTOR_UNAVAILABLE", "The doctor is unavailable during this slot.");
  }
}
