import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "./appError.js";

/**
 * plan.md §13 / §13.1 — the pure half of appointment status transitions, Day 21.
 * Same split as `bookingGuard.ts`, `slotGuard.ts` and `unavailability.ts`: every judgment here is a property of inputs the caller has already fetched (the appointment's current status, its slot's instants, the clinic's cutoff), so it is unit-testable with no database (`tests/transitionGuard.test.ts`) while the DB-backed races belong to `scripts/day21-dod.ts`.
 * This file holds the two things §13 turns on:
 * 1. **The transition matrix** — which `from → to` a given actor role may take.
 *    A pair that is not in `TRANSITION_MATRIX` is illegal for everyone (409 `INVALID_TRANSITION`, naming the current status and what IS allowed from it — §13.1's explicit error contract); a pair that exists but not for this role is 403 `FORBIDDEN`, matching `rbac.ts`.
 * 2. **The clock and condition walls** — `ARRIVED` only from the slot's start,
 *    `NO_SHOW` only after its end, the patient-cancel cutoff (waived for a clinic-caused appointment), the `§13.1` "settle the payment first" rule, and the mandatory-reason rule for staff actions.
 * **Who is deliberately absent from the matrix.** The §12 auto-cancel job also performs `CONFIRMED → CANCELLED`, but as a scheduled `system` actor with no `UserRole` (schema.prisma:849). It has its own path (`appointmentCascade.service.ts`) and does not route through this guard — the matrix below is the interactive, authenticated surface.
 * **The matrix is data, not branches**, so the §13 table is one readable list and the tests can assert the whole shape (no duplicate pair, every terminal status empty) rather than probe a nest of `if`s.
 */

/** The four terminal states (§13): they accept no further transition, ever. */
export const TERMINAL_STATUSES = [
  $Enums.AppointmentStatus.COMPLETED,
  $Enums.AppointmentStatus.NO_SHOW,
  $Enums.AppointmentStatus.CANCELLED,
  $Enums.AppointmentStatus.REJECTED,
] as const;

/** One row of the §13 matrix: a legal `from → to` and the roles that may take it. */
export interface TransitionRow {
  readonly from: $Enums.AppointmentStatus;
  readonly to: $Enums.AppointmentStatus;
  readonly roles: readonly $Enums.UserRole[];
}

/**
 * §13's transition matrix, transcribed row for row. The create row
 * (`— → CONFIRMED`) is not here: creating a booking is Day 19/32's service, not
 * a status change, and it is born `CONFIRMED` (§13).
 */
export const TRANSITION_MATRIX: readonly TransitionRow[] = [
  {
    from: $Enums.AppointmentStatus.CONFIRMED,
    to: $Enums.AppointmentStatus.ARRIVED,
    roles: [$Enums.UserRole.ADMIN, $Enums.UserRole.STAFF],
  },
  {
    from: $Enums.AppointmentStatus.CONFIRMED,
    to: $Enums.AppointmentStatus.CANCELLED,
    roles: [$Enums.UserRole.PATIENT, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF],
  },
  {
    from: $Enums.AppointmentStatus.CONFIRMED,
    to: $Enums.AppointmentStatus.NO_SHOW,
    roles: [$Enums.UserRole.ADMIN, $Enums.UserRole.STAFF],
  },
  {
    from: $Enums.AppointmentStatus.CONFIRMED,
    to: $Enums.AppointmentStatus.REJECTED,
    roles: [$Enums.UserRole.ADMIN, $Enums.UserRole.STAFF],
  },
  {
    from: $Enums.AppointmentStatus.ARRIVED,
    to: $Enums.AppointmentStatus.CANCELLED,
    roles: [$Enums.UserRole.ADMIN, $Enums.UserRole.STAFF],
  },
  {
    from: $Enums.AppointmentStatus.ARRIVED,
    to: $Enums.AppointmentStatus.COMPLETED,
    roles: [$Enums.UserRole.ADMIN, $Enums.UserRole.STAFF],
  },
];

/** True for a status that accepts no further transition (§13's terminal set). */
export function isTerminal(status: $Enums.AppointmentStatus): boolean {
  return (TERMINAL_STATUSES as readonly $Enums.AppointmentStatus[]).includes(status);
}

/**
 * The statuses reachable from `from`, regardless of role — the list §13.1 wants
 * in the refusal message ("what is allowed from it"). Empty for a terminal state.
 */
export function allowedTargets(from: $Enums.AppointmentStatus): $Enums.AppointmentStatus[] {
  return TRANSITION_MATRIX.filter((row) => row.from === from).map((row) => row.to);
}

/**
 * §13's matrix, enforced. An illegal pair is 409 `INVALID_TRANSITION` and names
 * the current status plus every target allowed from it; a legal pair attempted
 * by a role it does not admit is 403 `FORBIDDEN` (the `rbac.ts` contract).
 *
 * The status is compared against the row the caller read INSIDE its transaction,
 * so this is the authoritative test — the conditional `UPDATE … WHERE status =
 * from` in the service is the race backstop behind it, not a second opinion.
 */
export function assertTransition(
  from: $Enums.AppointmentStatus,
  to: $Enums.AppointmentStatus,
  actorRole: $Enums.UserRole,
): void {
  const row = TRANSITION_MATRIX.find((candidate) => candidate.from === from && candidate.to === to);

  if (row === undefined) {
    const targets = allowedTargets(from);
    const allowed = targets.length === 0 ? "nothing (terminal state)" : targets.join(", ");
    throw new AppError(
      409,
      "INVALID_TRANSITION",
      `An appointment in ${from} cannot move to ${to}. Allowed from ${from}: ${allowed}.`,
      { from, to, allowedFrom: targets },
    );
  }

  if (!row.roles.includes(actorRole)) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
}

/**
 * §13.1: `ARRIVED` is accepted "from the slot's start onward". Before the window
 * opens there is nobody to check in — a patient who walks in early is booked,
 * not arrived.
 */
export function assertArrivalAllowed(slotStartAt: Date, now: Date): void {
  if (now.getTime() < slotStartAt.getTime()) {
    throw new AppError(409, "SLOT_NOT_STARTED", "This appointment's slot has not started yet.");
  }
}

/**
 * §13.1: `NO_SHOW` is accepted "only once the slot's `endAt` has passed". Marking
 * someone absent before their window closes would overwrite a visit that may
 * still happen.
 */
export function assertNoShowAllowed(slotEndAt: Date, now: Date): void {
  if (now.getTime() < slotEndAt.getTime()) {
    throw new AppError(409, "SLOT_NOT_ENDED", "A no-show can be recorded only after the slot has ended.");
  }
}

/**
 * §8.5's patient-cancellation cutoff: a patient may cancel only before
 * `slotStartAt − cancelCutoffMinutes`; at or after it, and once the slot has
 * started, cancellation is refused. The cutoff is **waived** for a clinic-caused
 * appointment (the `doctorUnavailabilityId` marker, §8.5/§12), so those may be
 * cancelled until the slot starts. Clinic staff are not bound by the cutoff and
 * never call this.
 */
export function patientCancelBlockReason(
  slotStartAt: Date,
  now: Date,
  cancelCutoffMinutes: number,
  clinicCaused: boolean,
): string | null {
  if (now.getTime() >= slotStartAt.getTime()) {
    return "This appointment can no longer be cancelled — its slot has already started.";
  }

  if (clinicCaused) {
    return null;
  }

  const cutoffAt = slotStartAt.getTime() - cancelCutoffMinutes * 60_000;
  if (now.getTime() >= cutoffAt) {
    return `This appointment can no longer be cancelled — the cancellation cutoff is ${cancelCutoffMinutes} minutes before the slot starts.`;
  }

  return null;
}

export function assertPatientCancelAllowed(
  slotStartAt: Date,
  now: Date,
  cancelCutoffMinutes: number,
  clinicCaused: boolean,
): void {
  const blockReason = patientCancelBlockReason(slotStartAt, now, cancelCutoffMinutes, clinicCaused);
  if (blockReason !== null) {
    throw new AppError(409, "CUTOFF_REACHED", blockReason);
  }
}

/**
 * §13.1's closing wall: a visit cannot be closed (`COMPLETED` or `NO_SHOW`)
 * while a pay-at-clinic payment is still `PENDING`. Request-level validation, so
 * a completed visit can never leave an unclosed receivable on the books. No
 * `PENDING` payment exists until Phase 6, so today this is a guaranteed no-op —
 * it is wired now so the invariant holds from the moment payments land.
 */
export function assertNoPendingPayment(hasPendingPayment: boolean): void {
  if (hasPendingPayment) {
    throw new AppError(
      409,
      "PAYMENT_PENDING",
      "Settle or void the pending payment before closing the visit.",
    );
  }
}

/**
 * §8.4/§20's mandatory reason, on the staff actions that require one (§13's
 * `REJECTED` and `ARRIVED → CANCELLED`, plus any staff cancellation per §8.5).
 * Whitespace is not a reason. The HTTP schema refuses this first for a routed
 * call; this is the service-side twin (Day 12's double-enforcement) that the
 * DoD script and any future caller also get.
 */
export function assertReasonPresent(reason: string | null | undefined, action: string): void {
  if (reason === undefined || reason === null || reason.trim() === "") {
    throw new AppError(422, "REASON_REQUIRED", `A reason is required to ${action}.`);
  }
}

/**
 * The §13 timeline's event for a status change. Every non-create transition has
 * a 1:1 `AppointmentEventType` (§13's "booked → … → arrived → completed →
 * no-show"), so the history writer never has to guess. `CONFIRMED` has no event
 * (the row is BORN confirmed, so `BOOKED` is that event) and `PENDING` never
 * occurs — both are a 500 here, because reaching them would mean the matrix let
 * a value through it never should have.
 */
export function historyEventFor(status: $Enums.AppointmentStatus): $Enums.AppointmentEventType {
  switch (status) {
    case $Enums.AppointmentStatus.ARRIVED:
      return $Enums.AppointmentEventType.ARRIVED;
    case $Enums.AppointmentStatus.COMPLETED:
      return $Enums.AppointmentEventType.COMPLETED;
    case $Enums.AppointmentStatus.NO_SHOW:
      return $Enums.AppointmentEventType.NO_SHOW;
    case $Enums.AppointmentStatus.CANCELLED:
      return $Enums.AppointmentEventType.CANCELLED;
    case $Enums.AppointmentStatus.REJECTED:
      return $Enums.AppointmentEventType.REJECTED;
    default:
      throw new AppError(500, "NO_HISTORY_EVENT", `No appointment-history event corresponds to status ${status}`);
  }
}
