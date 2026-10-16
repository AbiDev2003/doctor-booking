import { $Enums } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type DbClient } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { isClinicCaused } from "../lib/unavailability.js";
import {
  assertArrivalAllowed,
  assertNoShowAllowed,
  assertNoPendingPayment,
  assertPatientCancelAllowed,
  assertReasonPresent,
  assertTransition,
  historyEventFor,
} from "../lib/transitionGuard.js";
import { getClinicSettings } from "./clinic.service.js";
import { writeAudit } from "./audit.service.js";
import { queueNotification } from "./notification.service.js";
import type { AppointmentDto } from "../schemas/appointments.js";
import type { ActorContext } from "./doctor.service.js";

/**
 * plan.md §13 / §13.1 — the appointment status-transition services, Day 21.
 *
 * Five verbs over `POST /api/v1/appointments/:id/...`, each a thin wrapper that
 * supplies its own §13 row plus the clock/condition wall the matrix row implies,
 * then hands off to ONE shared `performTransition`. Every rule the transition
 * turns on lives in the pure `lib/transitionGuard.ts`; this file owns only the
 * transaction — read, judge, conditionally write, and record.
 *
 * **The shared transaction, in order, and why the order is the argument:**
 *
 *   1. Load the appointment + its slot inside the transaction (the slot's
 *      `startAt`/`endAt` are what the §13.1 clock walls read).
 *   2. Ownership — only for the patient self-cancel path, and BEFORE the matrix,
 *      so a stranger gets 403 whether or not the status would allow the move.
 *   3. `assertTransition` — the §13 matrix against the status just read.
 *   4. The verb's own wall (arrival window, no-show window, patient cutoff).
 *   5. Closing a visit (`COMPLETED`/`NO_SHOW`) with a `PENDING` payment is
 *      refused (§13.1) — a no-op until Phase 6 has payment rows.
 *   6. `UPDATE … WHERE status = <the one we read>` — the race backstop. A
 *      transition that committed first wins; the loser gets a concrete 409.
 *   7. Freeing the seat, but only when the status LEAVES the seat-holding set
 *      (§8.1): `CANCELLED`/`REJECTED` free it, `ARRIVED`/`COMPLETED`/`NO_SHOW`
 *      do not.
 *   8. The `AppointmentHistory` event, the §18 notification row (cancel/reject
 *      only) and the §20 audit row — all in the same transaction, so a status
 *      change and its records commit together or not at all.
 */

/** The `HH:MM` a client renders from the slot's `@db.Time(0)` column. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

const APPOINTMENT_SELECT = {
  id: true,
  status: true,
  doctorId: true,
  doctorName: true,
  patientId: true,
  slotId: true,
  feeAmount: true,
  bookingTime: true,
  createdAt: true,
  doctorUnavailabilityId: true,
  patient: { select: { email: true } },
  slot: { select: { slotDate: true, startTime: true, endTime: true, startAt: true, endAt: true } },
} satisfies Prisma.AppointmentSelect;

type LoadedAppointment = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>;

/** The appointment as the API returns it, with `status` the transition's target. */
function toDto(appointment: LoadedAppointment, status: $Enums.AppointmentStatus): AppointmentDto {
  return {
    id: appointment.id,
    doctorId: appointment.doctorId,
    doctorName: appointment.doctorName,
    patientId: appointment.patientId,
    slotId: appointment.slotId,
    slotDate: appointment.slot.slotDate.toISOString().slice(0, 10),
    startTime: hhmm(appointment.slot.startTime),
    endTime: hhmm(appointment.slot.endTime),
    status,
    feeAmount: appointment.feeAmount,
    bookingTime: appointment.bookingTime.toISOString(),
    createdAt: appointment.createdAt.toISOString(),
  };
}

export interface TransitionInput {
  readonly actor: ActorContext;
  readonly appointmentId: string;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/** Cancel additionally carries the optional/required reason the actor depends on. */
export interface CancelInput extends TransitionInput {
  readonly reason?: string | null | undefined;
}

/**
 * The staff-only verbs (§13.1: Doctors may view the queue but never change
 * attendance) and the cancel set (a patient their own, staff anyone's). The
 * route gates on these first; the service re-checks (Day 12's
 * double-enforcement), and the matrix checks the exact pair once more.
 */
const STAFF_ROLES = [$Enums.UserRole.ADMIN, $Enums.UserRole.STAFF] as const;
const CANCEL_ROLES = [$Enums.UserRole.PATIENT, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF] as const;

function assertActorRole(actor: ActorContext, roles: readonly $Enums.UserRole[]): void {
  if (!roles.includes(actor.role)) {
    // The rbac.ts contract: one generic 403 so an endpoint-probing caller learns
    // nothing about which roles exist.
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
}

interface PerformInput {
  readonly actor: ActorContext;
  readonly appointmentId: string;
  readonly to: $Enums.AppointmentStatus;
  readonly reason?: string | null | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  /**
   * Runs after the row loads but BEFORE the matrix — the patient self-cancel
   * ownership check, which must not be masked by an INVALID_TRANSITION.
   */
  readonly ownership?: ((appointment: LoadedAppointment) => void) | undefined;
  /**
   * Runs after the matrix passes — the verb's clock/condition wall. Given the
   * loaded row, the transaction client and one shared `now`.
   */
  readonly guard?:
    | ((appointment: LoadedAppointment, tx: DbClient, now: Date) => void | Promise<void>)
    | undefined;
}

async function performTransition(input: PerformInput): Promise<AppointmentDto> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();

    const appointment = await tx.appointment.findUnique({
      where: { id: input.appointmentId },
      select: APPOINTMENT_SELECT,
    });
    if (appointment === null) {
      throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    }

    input.ownership?.(appointment);

    assertTransition(appointment.status, input.to, input.actor.role);

    if (input.guard !== undefined) {
      await input.guard(appointment, tx, now);
    }

    if (
      input.to === $Enums.AppointmentStatus.COMPLETED ||
      input.to === $Enums.AppointmentStatus.NO_SHOW
    ) {
      const pendingPayment = await tx.payment.count({
        where: { appointmentId: appointment.id, status: $Enums.PaymentStatus.PENDING },
      });
      assertNoPendingPayment(pendingPayment > 0);
    }

    // The authoritative change, conditional on the status just read: a
    // concurrent transition that committed first wins, and this request is the
    // loser with a concrete 409 rather than a silent double-write.
    const updated = await tx.appointment.updateMany({
      where: { id: appointment.id, status: appointment.status },
      data: { status: input.to },
    });
    if (updated.count !== 1) {
      const current = await tx.appointment.findUnique({
        where: { id: appointment.id },
        select: { status: true },
      });
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        `The appointment's status changed while this request was in flight; it is now ${current?.status ?? "unknown"}.`,
      );
    }

    // Leaving the seat-holding set frees the seat (§8.1). `gt: 0` so a stale
    // counter can never drive booked_count negative; the CHECK is the backstop.
    if (
      input.to === $Enums.AppointmentStatus.CANCELLED ||
      input.to === $Enums.AppointmentStatus.REJECTED
    ) {
      await tx.slot.updateMany({
        where: { id: appointment.slotId, bookedCount: { gt: 0 } },
        data: { bookedCount: { decrement: 1 } },
      });
    }

    const reason = input.reason ?? null;

    await tx.appointmentHistory.create({
      data: {
        appointmentId: appointment.id,
        eventType: historyEventFor(input.to),
        fromStatus: appointment.status,
        toStatus: input.to,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        actorName: input.actor.name,
        reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
        metadata: { slotId: appointment.slotId },
      },
    });

    // Cancelling and rejecting are the two transitions §18 emails about; arrival
    // and the attendance outcomes are internal desk states. The row is queued
    // now (`queueNotification`), sent from Phase 7. A provisional desk patient
    // with no email is skipped — `recipient` is NOT NULL (§16).
    const notifyType =
      input.to === $Enums.AppointmentStatus.CANCELLED
        ? $Enums.NotificationType.APPOINTMENT_CANCELLED
        : input.to === $Enums.AppointmentStatus.REJECTED
          ? $Enums.NotificationType.APPOINTMENT_REJECTED
          : null;
    if (notifyType !== null && appointment.patient.email !== null) {
      await queueNotification(tx, {
        type: notifyType,
        recipient: appointment.patient.email,
        appointmentId: appointment.id,
        slotId: appointment.slotId,
      });
    }

    await writeAudit(tx, {
      action: `APPOINTMENT_${input.to}`,
      targetType: "appointment",
      targetId: appointment.id,
      actor: { id: input.actor.id, role: input.actor.role, name: input.actor.name },
      before: { status: appointment.status },
      after: { status: input.to },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return toDto(appointment, input.to);
  });
}

/** §13: `CONFIRMED → ARRIVED` (ADMIN, STAFF), from the slot's start onward (§13.1). */
export function arriveAppointment(input: TransitionInput): Promise<AppointmentDto> {
  assertActorRole(input.actor, STAFF_ROLES);
  return performTransition({
    ...input,
    to: $Enums.AppointmentStatus.ARRIVED,
    guard: (appointment, _tx, now) => assertArrivalAllowed(appointment.slot.startAt, now),
  });
}

/**
 * §13: `ARRIVED → COMPLETED` (ADMIN, STAFF), never directly from `CONFIRMED` —
 * the matrix refuses the `CONFIRMED → COMPLETED` pair before this runs. The
 * `PENDING`-payment wall is applied by `performTransition`.
 */
export function completeAppointment(input: TransitionInput): Promise<AppointmentDto> {
  assertActorRole(input.actor, STAFF_ROLES);
  return performTransition({ ...input, to: $Enums.AppointmentStatus.COMPLETED });
}

/** §13: `CONFIRMED → NO_SHOW` (ADMIN, STAFF), only after the slot's `endAt` (§13.1). */
export function markNoShow(input: TransitionInput): Promise<AppointmentDto> {
  assertActorRole(input.actor, STAFF_ROLES);
  return performTransition({
    ...input,
    to: $Enums.AppointmentStatus.NO_SHOW,
    guard: (appointment, _tx, now) => assertNoShowAllowed(appointment.slot.endAt, now),
  });
}

/**
 * §13: `CONFIRMED → REJECTED` (ADMIN, STAFF) with a MANDATORY reason — the one
 * trigger is a desk policy/eligibility refusal (§13, §18).
 */
export function rejectAppointment(input: TransitionInput & { readonly reason: string }): Promise<AppointmentDto> {
  assertActorRole(input.actor, STAFF_ROLES);
  assertReasonPresent(input.reason, "reject a booking");
  return performTransition({ ...input, to: $Enums.AppointmentStatus.REJECTED, reason: input.reason });
}

/**
 * §13: `CONFIRMED → CANCELLED`, and `ARRIVED → CANCELLED` (staff only). A
 * patient may cancel only their OWN booking and only before the §8.5 cutoff
 * (waived for a clinic-caused appointment); staff may cancel any and are not
 * bounded by the cutoff but must supply a reason (§8.5). The matrix admits the
 * pair for all three roles, so the two paths differ only in these extra walls.
 */
export async function cancelAppointment(input: CancelInput): Promise<AppointmentDto> {
  assertActorRole(input.actor, CANCEL_ROLES);

  const isPatient = input.actor.role === $Enums.UserRole.PATIENT;
  if (!isPatient) {
    assertReasonPresent(input.reason, "cancel an appointment");
  }

  const clinic = await getClinicSettings();

  return performTransition({
    ...input,
    to: $Enums.AppointmentStatus.CANCELLED,
    ownership: (appointment) => {
      if (isPatient && appointment.patientId !== input.actor.id) {
        throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
      }
    },
    guard: (appointment, _tx, now) => {
      if (isPatient) {
        assertPatientCancelAllowed(
          appointment.slot.startAt,
          now,
          clinic.cancelCutoffMinutes,
          isClinicCaused(appointment),
        );
      }
    },
  });
}
