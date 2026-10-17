import { $Enums } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { utcToLocalDateTime } from "../lib/time.js";
import { bookingHorizon } from "../lib/availability.js";
import { isBookable } from "../lib/doctorState.js";
import { isClinicCaused } from "../lib/unavailability.js";
import {
  ACTIVE_BOOKING_STATUSES,
  assertNoDuplicateForSlot,
  assertSlotBookableForBooking,
} from "../lib/bookingGuard.js";
import { assertPatientCancelAllowed } from "../lib/transitionGuard.js";
import {
  assertNotSameSlot,
  assertRescheduleActor,
  assertRescheduleOwnership,
  assertRescheduleReason,
  assertRescheduleScope,
  assertReschedulableStatus,
  classifyRescheduleDelta,
} from "../lib/rescheduleGuard.js";
import { getClinicSettings } from "./clinic.service.js";
import { writeAudit } from "./audit.service.js";
import { queueNotification } from "./notification.service.js";
import type { DbClient } from "../lib/prisma.js";
import type { AppointmentDto } from "../schemas/appointments.js";
import type { ActorContext } from "./doctor.service.js";

/**
 * plan.md §14 / §8.5 / §15 / §8.1 — appointment rescheduling, Day 22.
 *
 * **The row moves, the status does not.** A reschedule is the SAME appointment
 * row pointed at a new slot (§14's locked row model), so nothing here writes a
 * status: `RESCHEDULED` is an `AppointmentHistory` event, not an
 * `AppointmentStatus` (§13). Keeping the row is what keeps the §15 same-slot
 * partial unique index and the per-patient cap working unchanged, and what
 * stops a patient's list from showing a dead predecessor.
 *
 * **The transaction, in order, and why the order is the argument:**
 *
 *   1. Load the appointment + its slot inside the transaction.
 *   2. Ownership (§7) — a patient their own booking, BEFORE any row-dependent
 *      rule, so a stranger gets 403 whatever the status is.
 *   3. `assertReschedulableStatus` — CONFIRMED only.
 *   4. `assertNotSameSlot` — the target must differ from the current slot.
 *   5. Load the target slot; `assertRescheduleScope` — a patient stays with the
 *      same doctor, staff may cross.
 *   6. Target bookability: the §5 doctor rule + Day 19's `assertSlotBookableForBooking`
 *      (disabled / started / horizon / unavailability), because a reschedule
 *      into a slot is a booking into it.
 *   7. One active booking per patient per target slot (§15) — excluding this
 *      appointment, which is leaving the old slot.
 *   8. The patient's §8.5 cutoff wall (`assertPatientCancelAllowed`, clinic-caused
 *      waiver included). Staff are not bound by it (§8.5's staff paragraph).
 *   9. The §14 fee delta, classified by `classifyRescheduleDelta` against the
 *      booking-time `feeAmount` snapshot and the appointment's payment state.
 *  10. `SELECT … FOR UPDATE` on BOTH slot rows, ordered by id — §15 names the
 *      reschedule as the case for this: it locks the two rows in one global
 *      order so an A→B / B→A pair of concurrent moves cannot deadlock.
 *  11. THE GUARDED UPDATE — claim the target seat (`booked + held < max`, 0 rows
 *      → `SLOT_FULL`), then release the old seat (guarded `> 0`). Both are the
 *      same atomic §15 statements booking uses.
 *  12. The conditional `UPDATE appointment … WHERE status = CONFIRMED AND slotId
 *      = <the one we read>` — the race backstop: a concurrent reschedule that
 *      committed first changed `slotId`, so this row count is 0 and THIS request
 *      loses with a concrete 409.
 *  13. A `QUEUE_REFUND` delta queues the §17 `RESCHEDULE_DELTA` refund row; the
 *      other branches settled at step 12 by writing the new `feeAmount`.
 *  14. The `RESCHEDULED` history event, the §18 `APPOINTMENT_RESCHEDULED`
 *      notification and the §20 audit row — same transaction, so the move and
 *      its records commit together or not at all.
 *
 * **Per-patient cap (step omitted on purpose).** §15 counts active bookings +
 * live holds; a reschedule moves one booking from one slot to another, so the
 * count is unchanged and re-checking it would only add a way to refuse a move
 * the patient is entitled to.
 */

export interface RescheduleInput {
  readonly actor: ActorContext;
  readonly appointmentId: string;
  readonly slotId: string;
  readonly reason?: string | null | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` a client renders. */
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
  slot: { select: { id: true, slotDate: true, startAt: true, endAt: true } },
} satisfies Prisma.AppointmentSelect;

export async function rescheduleAppointment(input: RescheduleInput): Promise<AppointmentDto> {
  // Route gates this too; re-enforced here so a miswired route cannot open
  // rescheduling to a doctor (Day 12's double-enforcement).
  assertRescheduleActor(input.actor.role);
  assertRescheduleReason(input.reason, input.actor.role);

  const now = new Date();
  const clinic = await getClinicSettings();
  const horizon = bookingHorizon(utcToLocalDateTime(now, clinic.timezone).date, clinic.bookingHorizonDays);

  try {
    return await prisma.$transaction(async (tx) => {
      /* 1. Load the appointment and its current slot. */
      const appointment = await tx.appointment.findUnique({
        where: { id: input.appointmentId },
        select: APPOINTMENT_SELECT,
      });
      if (appointment === null) {
        throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
      }

      /* 2–4. Ownership, status and "not the same slot". */
      assertRescheduleOwnership(input.actor, appointment.patientId);
      assertReschedulableStatus(appointment.status);
      assertNotSameSlot(appointment.slotId, input.slotId);

      /* 5. Load the target slot; enforce the patient's same-doctor scope. */
      const target = await tx.slot.findUnique({
        where: { id: input.slotId },
        select: {
          id: true,
          doctorId: true,
          slotDate: true,
          startTime: true,
          endTime: true,
          startAt: true,
          endAt: true,
          isDisabled: true,
          maxPatients: true,
          bookedCount: true,
          heldCount: true,
          doctor: {
            select: {
              id: true,
              fullName: true,
              role: true,
              doctorProfile: {
                select: { verificationStatus: true, suspendedAt: true, consultationFee: true },
              },
            },
          },
        },
      });
      if (target === null) {
        throw new AppError(404, "SLOT_NOT_FOUND", "Slot not found");
      }

      assertRescheduleScope(input.actor.role, appointment.doctorId, target.doctorId);

      const profile = target.doctor.doctorProfile;
      if (
        target.doctor.role !== $Enums.UserRole.DOCTOR ||
        profile === null ||
        !isBookable({ verificationStatus: profile.verificationStatus, suspendedAt: profile.suspendedAt })
      ) {
        // The same generic miss booking uses (§26): a hidden doctor reveals nothing.
        throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
      }

      /* 6. The target slot's non-capacity bookability against live rows. */
      const targetSlotDate = target.slotDate.toISOString().slice(0, 10);
      const unavailabilities = await tx.doctorUnavailability.findMany({
        where: { doctorId: target.doctorId, startAt: { lt: target.endAt }, endAt: { gt: target.startAt } },
        select: { startAt: true, endAt: true },
      });
      assertSlotBookableForBooking(
        {
          slotDate: targetSlotDate,
          startAt: target.startAt,
          endAt: target.endAt,
          isDisabled: target.isDisabled,
          maxPatients: target.maxPatients,
          bookedCount: target.bookedCount,
          heldCount: target.heldCount,
        },
        { now, minLeadMinutes: clinic.minLeadMinutes, horizon, unavailabilities },
      );

      /* 7. One active booking per patient per target slot — excluding this row. */
      const duplicate = await tx.appointment.findFirst({
        where: {
          patientId: appointment.patientId,
          slotId: target.id,
          status: { in: [...ACTIVE_BOOKING_STATUSES] },
          id: { not: appointment.id },
        },
        select: { id: true },
      });
      assertNoDuplicateForSlot(duplicate !== null);

      /* 8. The patient's §8.5 cutoff (waived for a clinic-caused booking). Staff are not bound. */
      if (input.actor.role === $Enums.UserRole.PATIENT) {
        assertPatientCancelAllowed(
          appointment.slot.startAt,
          now,
          clinic.cancelCutoffMinutes,
          isClinicCaused(appointment),
        );
      }

      /* 9. §14's fee delta against the booking-time snapshot and the payment state. */
      const nextFeeAmount = profile.consultationFee ?? clinic.defaultConsultationFee;
      const paidPayments = await tx.payment.count({
        where: { appointmentId: appointment.id, status: $Enums.PaymentStatus.PAID },
      });
      const delta = classifyRescheduleDelta(appointment.feeAmount, nextFeeAmount, paidPayments > 0);

      /* 10. §15's explicit two-row lock, in one global order (id) so opposite moves cannot deadlock. */
      await tx.$queryRaw`
        SELECT id FROM slots
        WHERE id IN (${appointment.slotId}::uuid, ${target.id}::uuid)
        ORDER BY id
        FOR UPDATE
      `;

      /* 11a. Claim the target seat — the authoritative capacity decision (§15). */
      const consuming = await tx.$executeRaw`
        UPDATE slots SET booked_count = booked_count + 1
        WHERE id = ${target.id}::uuid AND booked_count + held_count < max_patients
      `;
      if (consuming === 0) {
        throw new AppError(409, "SLOT_FULL", "That slot is fully booked.");
      }

      /* 11b. Release the old seat — guarded so a stale counter cannot go negative. */
      await tx.slot.updateMany({
        where: { id: appointment.slotId, bookedCount: { gt: 0 } },
        data: { bookedCount: { decrement: 1 } },
      });

      /* 12. Move the row — conditional on the values just read. */
      const updated = await tx.appointment.updateMany({
        where: { id: appointment.id, status: appointment.status, slotId: appointment.slotId },
        data: {
          slotId: target.id,
          doctorId: target.doctorId,
          doctorName: target.doctor.fullName,
          feeAmount: nextFeeAmount,
          // The new slot passed the DOCTOR_UNAVAILABLE bookability check, so it
          // does not overlap the disruption: the booking is no longer clinic-caused,
          // and leaving the marker would let the §12 auto-cancel job kill it.
          doctorUnavailabilityId: null,
        },
      });
      if (updated.count !== 1) {
        const current = await tx.appointment.findUnique({
          where: { id: appointment.id },
          select: { status: true, slotId: true },
        });
        throw new AppError(
          409,
          "INVALID_TRANSITION",
          `The appointment changed while this request was in flight (now ${current?.status ?? "unknown"}).`,
        );
      }

      /* 13. A cheaper move against money already paid queues the §17 refund row. */
      if (delta.action === "QUEUE_REFUND") {
        await queueRescheduleRefund(tx, appointment.id, delta.refundAmountPaise, input.reason ?? null, input.actor);
      }

      /* 14. History, notification and audit — one transaction with the move. */
      const fromSlotDate = appointment.slot.slotDate.toISOString().slice(0, 10);
      await tx.appointmentHistory.create({
        data: {
          appointmentId: appointment.id,
          eventType: $Enums.AppointmentEventType.RESCHEDULED,
          fromStatus: appointment.status,
          toStatus: appointment.status,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorName: input.actor.name,
          reason: input.reason ?? null,
          ip: input.ip ?? null,
          requestId: input.requestId ?? null,
          metadata: {
            fromSlotId: appointment.slotId,
            toSlotId: target.id,
            fromSlotDate,
            toSlotDate: targetSlotDate,
            fromDoctorId: appointment.doctorId,
            toDoctorId: target.doctorId,
            fromFeeAmount: appointment.feeAmount,
            toFeeAmount: nextFeeAmount,
            deltaPaise: delta.deltaPaise,
            refundAmountPaise: delta.refundAmountPaise,
            clinicCausedMarkerCleared: appointment.doctorUnavailabilityId !== null,
          },
        },
      });

      if (appointment.patient.email !== null) {
        await queueNotification(tx, {
          type: $Enums.NotificationType.APPOINTMENT_RESCHEDULED,
          recipient: appointment.patient.email,
          appointmentId: appointment.id,
          slotId: target.id,
        });
      }

      await writeAudit(tx, {
        action: "APPOINTMENT_RESCHEDULED",
        targetType: "appointment",
        targetId: appointment.id,
        actor: { id: input.actor.id, role: input.actor.role, name: input.actor.name },
        before: {
          status: appointment.status,
          slotId: appointment.slotId,
          doctorId: appointment.doctorId,
          feeAmount: appointment.feeAmount,
        },
        after: {
          status: appointment.status,
          slotId: target.id,
          doctorId: target.doctorId,
          feeAmount: nextFeeAmount,
          deltaPaise: delta.deltaPaise,
        },
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return {
        id: appointment.id,
        doctorId: target.doctorId,
        doctorName: target.doctor.fullName,
        patientId: appointment.patientId,
        slotId: target.id,
        slotDate: targetSlotDate,
        startTime: hhmm(target.startTime),
        endTime: hhmm(target.endTime),
        status: appointment.status,
        feeAmount: nextFeeAmount,
        bookingTime: appointment.bookingTime.toISOString(),
        createdAt: appointment.createdAt.toISOString(),
      };
    });
  } catch (err) {
    // The §15 partial unique index is the guarantee; step 7 is the clean path.
    // Two of this patient's rows racing into the same target map to the same 409.
    if (isUniqueConstraintViolation(err)) {
      throw new AppError(409, "ALREADY_BOOKED", "You already have a booking for that slot.");
    }
    throw err;
  }
}

/**
 * §14/§17: the `PENDING` `RESCHEDULE_DELTA` refund owed when a paid booking
 * moves to a cheaper slot/doctor. Keyed by `(paymentId, kind)` and upserted, so
 * a retried reschedule cannot double-refund while a later cancellation refund
 * against the same payment still can (§24's pair-key note). Unreachable until
 * Phase 6 has `Payment` rows — the seam is built now so the refund executor
 * (Day 25) has the row waiting for it.
 */
async function queueRescheduleRefund(
  client: DbClient,
  appointmentId: string,
  refundAmountPaise: number,
  reason: string | null,
  actor: ActorContext,
): Promise<void> {
  const payment = await client.payment.findFirst({
    where: { appointmentId, status: $Enums.PaymentStatus.PAID },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!payment) return;

  await client.refund.upsert({
    where: { paymentId_kind: { paymentId: payment.id, kind: $Enums.RefundKind.RESCHEDULE_DELTA } },
    create: {
      paymentId: payment.id,
      kind: $Enums.RefundKind.RESCHEDULE_DELTA,
      amountPaise: refundAmountPaise,
      status: $Enums.RefundStatus.PENDING,
      reason: reason ?? "Rescheduled to a lower-fee slot/doctor (§14)",
      actorId: actor.id,
      actorRole: actor.role,
      actorName: actor.name,
    },
    update: {},
  });
}
