import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "./appError.js";

/**
 * plan.md §8.4 — the pure guard that decides what may be done to a dated Slot,
 * Day 16.
 *
 * Everything this file judges becomes properties of inputs the caller has
 * already fetched; it never touches the database, config or the request
 * (the `doctorState.ts` precedent: split the judgment from the I/O so the
 * judgment gets real tests — Day 16's `tests/slotGuard.test.ts` pins it while
 * the DB-backed harness still belongs to Day 36).
 *
 * Two prohibitions from §8.4 live here, and they share one seat-or-hold test:
 *
 * 1. **Editing a slot's date/times is blocked while the slot still holds a
 *    seat or a live hold.** "Holds a seat" is `CONFIRMED` or `ARRIVED`
 *    unconditionally, **or** `COMPLETED`/`NO_SHOW` while the slot has not
 *    ended — §13.1: those two keep their seat until the window ends, and §8.1
 *    counts them in `bookedCount`. A live hold is a `SeatHold` with
 *    `releasedAt IS NULL AND expiresAt > now()` (§8.6), because a hold's
 *    expiry is capped at `slot.startAt` (moving a slot's start would silently
 *    move the deadline of an already-reserved seat).
 * 2. **Disabling (or removing) a slot is blocked under the same test** — one
 *    shared predicate, not two that can drift apart (loophole B3). After the
 *    patients are rescheduled/cancelled the slot may be disabled, audited.
 *
 * **Capacity-only edits stay allowed and must never touch the times** (§8.4) —
 * the seat-or-hold test does not apply to them. What DOES apply to capacity is
 * the mandatory-reason rule and the lowering guard: lowering `maxPatients`
 * below `bookedCount + heldCount` is refused with the §8.4 message, because a
 * live hold is a promise of a seat too.
 *
 * Note the asymmetry this module encodes deliberately: the lowering guard keys
 * off the **stored counters** (`bookedCount`/`heldCount` — §8.1, read fresh
 * inside the caller's transaction), while the seat-or-hold test re-checks the
 * **live rows** (appointments in a holding status, plus unreleased holds)
 * rather than trusting a counter. That is exactly what §8.6 mandates for every
 * decision that must not be stale, and it is why a doctored counter can never
 * smuggle a time-edit through.
 *
 * Every refusal is an `AppError` with a specific code (404/409/422) so a
 * legitimate client can branch without parsing prose.
 */

/** The four statuses that keep a seat (§8.1: CONFIRMED, ARRIVED always; COMPLETED, NO_SHOW until the slot ends, §13.1). */
export const SEAT_HOLDING_STATUSES = [
  $Enums.AppointmentStatus.CONFIRMED,
  $Enums.AppointmentStatus.ARRIVED,
  $Enums.AppointmentStatus.COMPLETED,
  $Enums.AppointmentStatus.NO_SHOW,
] as const;

/**
 * True when `status` holds a seat on a slot that ends at `slotEndAt`, judged
 * at `now`. `CONFIRMED`/`ARRIVED` always hold; `COMPLETED`/`NO_SHOW` hold only
 * while the window has not ended (§13.1). Any other status (PENDING,
 * CANCELLED, REJECTED) never holds.
 */
export function statusHoldsSeat(
  status: $Enums.AppointmentStatus,
  slotEndAt: Date,
  now: Date,
): boolean {
  if (status === $Enums.AppointmentStatus.CONFIRMED || status === $Enums.AppointmentStatus.ARRIVED) {
    return true;
  }
  if (status === $Enums.AppointmentStatus.COMPLETED || status === $Enums.AppointmentStatus.NO_SHOW) {
    return slotEndAt.getTime() > now.getTime();
  }
  return false;
}

/** The §8.6 live-hold predicate: unreleased AND unexpired is a live hold. */
export function holdIsLive(hold: { readonly releasedAt: Date | null; readonly expiresAt: Date }, now: Date): boolean {
  return hold.releasedAt === null && hold.expiresAt.getTime() > now.getTime();
}

/** The seat-or-hold test (loophole B3): any holding appointment or live hold? */
export function slotHoldsSeatOrLiveHold(
  appointments: readonly { readonly status: $Enums.AppointmentStatus; readonly slotEndAt: Date }[],
  holds: readonly { readonly releasedAt: Date | null; readonly expiresAt: Date }[],
  now: Date,
): boolean {
  const anySeat = appointments.some((appointment) => statusHoldsSeat(appointment.status, appointment.slotEndAt, now));
  const anyHold = holds.some((hold) => holdIsLive(hold, now));
  return anySeat || anyHold;
}

/**
 * §8.4's seat-or-hold refusal, shared by time-edit and disable (decision 3).
 * Both prohibitions say the same thing: moving or removing a slot that still
 * promises a seat silently breaks a patient's booking, so staff must create a
 * new slot / reschedule first. One message reads naturally for either verb.
 */
export function assertNoSeatOrLiveHold(
  appointments: readonly { readonly status: $Enums.AppointmentStatus; readonly slotEndAt: Date }[],
  holds: readonly { readonly releasedAt: Date | null; readonly expiresAt: Date }[],
  now: Date,
): void {
  if (slotHoldsSeatOrLiveHold(appointments, holds, now)) {
    throw new AppError(
      409,
      "SLOT_HELD",
      "This slot still holds a seat or an active payment hold — reschedule or cancel the booking before changing it",
    );
  }
}

/**
 * §8.4's capacity-lower guard, keyed off the stored counters. Refuses a
 * `maxPatients` drop that would fall below `bookedCount + heldCount`, with the
 * plan's exact wording. Capacity-only edits are otherwise always allowed.
 */
export function assertCapacityNotBelowCounters(
  newMaxPatients: number,
  bookedCount: number,
  heldCount: number,
): void {
  if (newMaxPatients < bookedCount + heldCount) {
    throw new AppError(
      409,
      "CAPACITY_BELOW_BOOKED",
      `${bookedCount} patients booked and ${heldCount} awaiting payment for this slot`,
    );
  }
}