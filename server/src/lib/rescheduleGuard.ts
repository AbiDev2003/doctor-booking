import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "./appError.js";
import { assertReasonPresent } from "./transitionGuard.js";

/**
 * plan.md §14 / §8.5 — the pure half of appointment rescheduling, Day 22.
 *
 * Same split as `transitionGuard.ts`, `bookingGuard.ts` and `slotGuard.ts`:
 * every judgment here is a property of inputs the caller has already fetched
 * (the appointment's status, the two slot ids, the actor's role, the two fee
 * numbers), so it is unit-testable with no database (`tests/rescheduleGuard.test.ts`)
 * while the DB-backed races belong to `scripts/day22-dod.ts`.
 *
 * What lives here:
 *
 * 1. **Who may reschedule** — PATIENT / ADMIN / STAFF only (a doctor never
 *    mutates an appointment, §4/§28, the Day 21 posture), a patient only their
 *    OWN booking, and a patient only within the SAME doctor (§14's locked
 *    scope: a cross-doctor move for a patient is a cancel-and-rebook the plan
 *    refuses to call a reschedule). STAFF/ADMIN may cross doctors.
 * 2. **What may be rescheduled** — a `CONFIRMED` row only, moving to a
 *    different slot. `RESCHEDULED` is a history event, never a status (§13/§14),
 *    so the row's status never changes on this path; an ARRIVED (in-progress)
 *    or terminal booking is refused with the same 409 code the §13 matrix uses.
 * 3. **The reason rule** — mandatory for STAFF/ADMIN (every staff reschedule is
 *    an audited §20 action with a reason), optional for a patient, mirroring
 *    Day 21's cancel split. The HTTP schema refuses a blank reason first; this
 *    is the service-side twin every caller gets.
 * 4. **The fee-delta branch (§14)** — `delta = nextFee − feeAmount` (the
 *    booking-time snapshot), classified against whether the appointment has a
 *    PAID payment row. See `classifyRescheduleDelta` for why the money itself
 *    is settled differently before and after Phase 6.
 *
 * Deliberately NOT here:
 *
 * - **The patient's §8.5 cutoff wall** — it is literally `assertPatientCancelAllowed`
 *   (transitionGuard.ts) with the same clinic-caused waiver, so §14's "rescheduling
 *   follows the same rule" is one shared function rather than a second copy that
 *   can drift. The service calls it directly; Day 22's test suite inherits
 *   transitionGuard.test.ts's coverage of it.
 * - **Target-slot bookability and capacity** — Day 19's `assertSlotBookableForBooking`
 *   judges the non-capacity conditions and the atomic guarded `UPDATE` judges
 *   fullness, exactly as booking does. A reschedule is a booking into a new slot
 *   with a seat released from the old one, so it reuses the same guards rather
 *   than restating them.
 */

/** §14/§13: only a CONFIRMED booking moves. ARRIVED is in progress; the rest are terminal or unreachable. */
export const RESCHEDULABLE_STATUS = $Enums.AppointmentStatus.CONFIRMED;

/** The three roles that may reach a reschedule route; DOCTOR is deliberately absent (§4, §28). */
export const RESCHEDULE_ROLES = [
  $Enums.UserRole.PATIENT,
  $Enums.UserRole.ADMIN,
  $Enums.UserRole.STAFF,
] as const;

/**
 * The coarse role gate, re-checked inside the service so a miswired route
 * cannot open rescheduling to a doctor (Day 12's double-enforcement, the
 * `rbac.ts` generic 403 contract).
 */
export function assertRescheduleActor(role: $Enums.UserRole): void {
  if (!(RESCHEDULE_ROLES as readonly $Enums.UserRole[]).includes(role)) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
}

/**
 * §7 ownership: a patient may move only their OWN booking. Checked BEFORE any
 * row-dependent rule so a stranger gets 403 regardless of the appointment's
 * status — same order argument as Day 21's cancel ownership hook.
 */
export function assertRescheduleOwnership(
  actor: { readonly id: string; readonly role: $Enums.UserRole },
  appointmentPatientId: string,
): void {
  if (actor.role === $Enums.UserRole.PATIENT && actor.id !== appointmentPatientId) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
}

/**
 * §14's row rule: the appointment must be CONFIRMED. The code matches the §13
 * matrix's refusal so a client has one code for "this status cannot do that",
 * and the message names what it actually is.
 */
export function assertReschedulableStatus(status: $Enums.AppointmentStatus): void {
  if (status !== RESCHEDULABLE_STATUS) {
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `Only a ${RESCHEDULABLE_STATUS} appointment can be rescheduled — this one is ${status}.`,
      { from: status, reschedulable: RESCHEDULABLE_STATUS },
    );
  }
}

/**
 * §14: a reschedule MOVES the row to a different slot — the same slot is not a
 * move. 422 rather than 409: the request is well-formed but its two slot ids
 * describe no change, which is the input's fault, not a conflict with state
 * (the same reasoning as Day 11's 422s for malformed shapes).
 */
export function assertNotSameSlot(currentSlotId: string, targetSlotId: string): void {
  if (currentSlotId === targetSlotId) {
    throw new AppError(
      422,
      "SAME_SLOT",
      "This appointment is already in that slot — pick a different time.",
    );
  }
}

/**
 * §14's locked scope: a PATIENT moves within the SAME doctor only. A
 * cross-doctor move is staff territory — at the desk it is one real-world
 * action, but for a patient the plan models it as cancel + rebook so the fee,
 * the queue position and the refund classification stay unambiguous. Its own
 * code (not the generic FORBIDDEN) so the patient-facing client can explain
 * the refusal instead of showing a dead button.
 */
export function assertRescheduleScope(
  actorRole: $Enums.UserRole,
  appointmentDoctorId: string,
  targetDoctorId: string,
): void {
  if (actorRole === $Enums.UserRole.PATIENT && appointmentDoctorId !== targetDoctorId) {
    throw new AppError(
      403,
      "CROSS_DOCTOR_RESCHEDULE",
      "You can reschedule to a different time with the same doctor only — switching doctors is handled at the clinic desk.",
      { appointmentDoctorId, targetDoctorId },
    );
  }
}

/**
 * §8.4/§20's mandatory reason on staff reschedules (§14 requires it on the
 * cross-doctor move specifically; one rule across every staff reschedule beats
 * a per-route branch). A patient's own reason stays optional — same split as
 * Day 21's cancel.
 */
export function assertRescheduleReason(
  reason: string | null | undefined,
  actorRole: $Enums.UserRole,
): void {
  if (actorRole === $Enums.UserRole.PATIENT) return;
  assertReasonPresent(reason, "reschedule an appointment");
}

/** How the §14 fee delta is settled by the service. */
export type RescheduleDeltaAction = "NONE" | "ADJUST_SNAPSHOTS" | "QUEUE_REFUND";

export interface RescheduleDeltaPlan {
  /** `nextFeeAmount − currentFeeAmount`, in paise. Negative means the patient moves to a cheaper slot/doctor. */
  readonly deltaPaise: number;
  readonly action: RescheduleDeltaAction;
  /** Positive paise to refund. 0 unless `action` is `QUEUE_REFUND`. */
  readonly refundAmountPaise: number;
}

/**
 * §14's price rule, classified: `delta = nextFee − feeAmount` where `feeAmount`
 * is the booking-time snapshot (never re-derived from a "current" fee — §14's
 * whole point is that a later fee change never rewrites what was agreed).
 *
 * **Why the settlement differs by payment state.** §14 says delta>0 is paid
 * "through the normal payment flow before the move commits" and delta<0 is
 * refunded automatically — but that flow is Phase 6 (Days 23–26), which this
 * day precedes, and today every appointment is pay-at-clinic with zero `Payment`
 * rows. So:
 *
 * - **No PAID payment** (every appointment until Day 24, and every pay-at-clinic
 *   booking forever): there is no money standing, so nothing can be collected
 *   or returned through a gateway. The settlement is the SNAPSHOT ITSELF — the
 *   service writes `feeAmount = nextFee`, and the desk later collects that at
 *   the clinic (Day 26 records `feeAmount`). The delta still lands in the
 *   `AppointmentHistory` metadata, so the move stays auditable. This is not
 *   "rewriting what the patient agreed to": a reschedule is a new agreement,
 *   and updating the snapshot is what keeps the later cancellation refund
 *   arithmetic (Day 25) anchored to what is actually owed.
 * - **PAID payment + delta > 0** — the patient owes MORE money and the flow
 *   that could take it does not exist yet: refuse. `PAYMENT_REQUIRED` is a
 *   guaranteed no-op until Phase 6, exactly like Day 21's `assertNoPendingPayment`
 *   wall: the guard is in place before money rows exist, so Phase 6 wires the
 *   collection behind an already-enforced invariant instead of reopening this day.
 * - **PAID payment + delta < 0** — money IS standing, so the difference is owed
 *   back: queue a `PENDING` `Refund` with `kind = RESCHEDULE_DELTA` (the enum
 *   exists for exactly this, schema.prisma:176), keyed by `(paymentId, kind)`
 *   so a retried reschedule cannot double-refund. The gateway call is Day 25's
 *   executor; until then the row is the durable "this refund is owed" record
 *   (§14: every delta is written to the payment trail).
 *
 * Unreachable-with-money branches are classified here rather than omitted so
 * the whole §14 rule is one testable function and Phase 6 has no decision left
 * to make.
 */
export function classifyRescheduleDelta(
  currentFeeAmount: number,
  nextFeeAmount: number,
  hasPaidPayment: boolean,
): RescheduleDeltaPlan {
  const deltaPaise = nextFeeAmount - currentFeeAmount;

  if (deltaPaise === 0) {
    return { deltaPaise: 0, action: "NONE", refundAmountPaise: 0 };
  }

  if (hasPaidPayment) {
    if (deltaPaise > 0) {
      throw new AppError(
        409,
        "PAYMENT_REQUIRED",
        "This reschedule costs more than the current booking — settle the fee difference before the move can commit.",
        { deltaPaise },
      );
    }
    return { deltaPaise, action: "QUEUE_REFUND", refundAmountPaise: -deltaPaise };
  }

  return { deltaPaise, action: "ADJUST_SNAPSHOTS", refundAmountPaise: 0 };
}
