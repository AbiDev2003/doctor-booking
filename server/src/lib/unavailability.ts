import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "./appError.js";

/**
 * plan.md §12 — the pure half of the DoctorUnavailability cascade, Day 18.
 *
 * Same split as `lib/availability.ts`, `lib/doctorState.ts` and
 * `lib/slotGuard.ts`: the I/O (finding overlapping rows, writing markers,
 * queuing notifications) lives in `appointmentCascade.service.ts`, while the
 * two JUDGMENTS the cascade turns on live here so they can be unit-tested
 * without a database and reused by every later day that asks the same question.
 *
 * The judgments:
 *
 * 1. **Who is "affected" (§12) and who is never touched ([T]).** Only a
 *    CONFIRMED appointment is in the cascade. ARRIVED means the patient is
 *    already in the building, and COMPLETED/NO_SHOW are history —
 *    "attendance is never overwritten" is exactly this filter. The same
 *    predicate guards BOTH the mark-time selection and the §12 auto-cancel job,
 *    because "still CONFIRMED" is the property that must hold at the instant of
 *    cancellation, not merely at the instant the disruption was created.
 *
 * 2. **Is this booking clinic-caused (§12/§17)?** Derived from the FK marker
 *    being non-null, per the schema's deliberate "no isClinicCaused boolean"
 *    rule (schema.prisma:598). One function, exported so the cancel/refund
 *    classification (Days 21/22) shares this exact definition rather than
 *    re-deriving it.
 */

/**
 * The only status §12 cascades on. Named rather than inlined so the auto-cancel
 * job, the mark-time selection and the tests all read the same value.
 */
export const CASCADABLE_STATUS = $Enums.AppointmentStatus.CONFIRMED;

/**
 * §12 + the [T] rule: of the appointments present, only the ones still
 * CONFIRMED are cascadable. A COMPLETED/NO_SHOW/ARRIVED/CANCELLED row is left
 * exactly as it is.
 */
export function selectOnlyConfirmed<T extends { readonly status: $Enums.AppointmentStatus }>(
  appointments: readonly T[],
): T[] {
  return appointments.filter((appointment) => appointment.status === CASCADABLE_STATUS);
}

/**
 * §12's clinic-caused fact, derived and never stored: an appointment is
 * clinic-caused exactly when it carries the disruption marker. The whole point
 * of the marker column is that a second boolean could disagree with it
 * (§17 would then refund the wrong patients), so this is the single reader.
 */
export function isClinicCaused(appointment: {
  readonly doctorUnavailabilityId: string | null;
}): boolean {
  return appointment.doctorUnavailabilityId !== null;
}

/**
 * A disruption window must have positive length. The HTTP schema already
 * enforces `endTime > startTime`, but a service leaves the boundary check in
 * one place for every caller (routes and scripts alike), mirroring
 * `updateSlot`'s merged-window re-check. Past and ongoing windows ARE allowed
 * — §12 covers marking a disruption after the fact (§8.4's analogous slot
 * rules are about seats, not clocks).
 */
export function assertValidDisruptionWindow(startAt: Date, endAt: Date): void {
  if (endAt.getTime() <= startAt.getTime()) {
    throw new AppError(
      422,
      "INVALID_WINDOW",
      "The unavailability window must end after it starts",
    );
  }
}
