import { $Enums } from "../../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../../lib/prisma.js";
import { AppError } from "../../lib/appError.js";
import { utcToLocalDateTime } from "../../lib/time.js";
import { bookingHorizon } from "../../lib/availability.js";
import { isBookable } from "../../lib/doctorState.js";
import { deriveConsultationFee } from "../../lib/fee.js";
import {
  ACTIVE_BOOKING_STATUSES,
  assertNoDuplicateForSlot,
  assertPatientSeatCap,
  assertSlotBookableForBooking,
} from "../../lib/bookingGuard.js";
import { getClinicSettings } from "../clinic.service.js";
import { writeAudit } from "../audit.service.js";
import { queueNotification } from "../notifications/notification.service.js";
import type { AppointmentDto } from "../../schemas/appointments.js";
import type { ActorContext } from "../doctors/doctor.service.js";

/**
 * plan.md §15 / §8.1 / §13 — book a slot, Day 19 (pay-at-clinic path).
 *
 * One transaction, in this order, and the order is the correctness argument:
 *
 *   1. `SELECT … FROM users WHERE id = patient FOR UPDATE` — the §15 patient-row
 *      lock. It serializes this patient's concurrent attempts for the whole
 *      transaction, which is what makes the per-patient cap (step 5) safe from a
 *      read-then-write race, and it is where §6.3's email-verified gate is read.
 *   2. Load the slot + doctor and re-apply §5's bookability rule in-transaction
 *      (a suspended doctor cannot be raced into a booking).
 *   3. The non-capacity guards: disabled/started/horizon/unavailability (§8.5,
 *      §10, §11, §12).
 *   4. The same-slot duplicate check — the clean 409 in front of §15's partial
 *      unique index, which the catch below also maps.
 *   5. The per-patient cap, counting CONFIRMED/ARRIVED bookings **and** live
 *      holds (§15).
 *   6. THE GUARDED UPDATE — `booked_count + 1 WHERE booked_count + held_count <
 *      max_patients`. This is the only authoritative capacity decision; zero
 *      rows affected is `SLOT_FULL`. Prisma's `where` cannot express a
 *      column-vs-column comparison, so it is raw SQL (§15's literal statement).
 *   7. Create the appointment born `CONFIRMED` with its booking-time snapshots,
 *      its PENDING pay-at-clinic receivable (when the fee is non-zero), its
 *      `AppointmentHistory` BOOKED event and its audit row — all in the same
 *      transaction, so the seat, the booking, its receivable and its records
 *      commit or none.
 *
 * No `SeatHold` here: pay-at-clinic has no money upfront and nothing to hold
 * (§17). The `Payment` row is the desk's receivable, born `PENDING` and settled
 * by the Day 26 collection route or voided when the booking is cancelled. The
 * queue position (a rank over `bookingTime`, never a stored counter) falls out
 * of this row later.
 */

export interface BookAppointmentInput {
  readonly actor: ActorContext;
  readonly slotId: string;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` a client renders. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

export async function bookAppointment(input: BookAppointmentInput): Promise<AppointmentDto> {
  // Day 19 is patient self-booking only (desk/walk-in is Day 3. The route gates this too; re-enforced here so a miswired route cannot open it up
  // (Day 12's double-enforcement).
  if (input.actor.role !== $Enums.UserRole.PATIENT) {
    throw new AppError(403, "FORBIDDEN", "Only a patient can book an appointment");
  }

  const patientId = input.actor.id;
  const now = new Date();
  const clinic = await getClinicSettings();
  const horizon = bookingHorizon(utcToLocalDateTime(now, clinic.timezone).date, clinic.bookingHorizonDays);

  try {
    return await prisma.$transaction(async (tx) => {
      /* 1. Lock the patient row and read §6.3's verification flag. */
      const locked = await tx.$queryRaw<{ email_verified_at: Date | null }[]>`
        SELECT email_verified_at FROM users WHERE id = ${patientId}::uuid FOR UPDATE
      `;
      const patientRow = locked[0];
      if (!patientRow) {
        throw new AppError(404, "PATIENT_NOT_FOUND", "Patient not found");
      }
      if (patientRow.email_verified_at === null) {
        throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before booking an appointment.");
      }

      /* 2. Load the slot + doctor; re-apply §5 bookability inside the transaction. */
      const slot = await tx.slot.findUnique({
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
      if (!slot) {
        throw new AppError(404, "SLOT_NOT_FOUND", "Slot not found");
      }

      const profile = slot.doctor.doctorProfile;
      if (
        slot.doctor.role !== $Enums.UserRole.DOCTOR ||
        profile === null ||
        !isBookable({ verificationStatus: profile.verificationStatus, suspendedAt: profile.suspendedAt })
      ) {
        // The same generic miss the public surface uses (§26): a hidden doctor reveals nothing about existing.
        throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
      }

      /* 3. Non-capacity guards against live rows. */
      const slotDate = slot.slotDate.toISOString().slice(0, 10);
      const unavailabilities = await tx.doctorUnavailability.findMany({
        where: { doctorId: slot.doctorId, startAt: { lt: slot.endAt }, endAt: { gt: slot.startAt } },
        select: { startAt: true, endAt: true },
      });
      assertSlotBookableForBooking(
        {
          slotDate,
          startAt: slot.startAt,
          endAt: slot.endAt,
          isDisabled: slot.isDisabled,
          maxPatients: slot.maxPatients,
          bookedCount: slot.bookedCount,
          heldCount: slot.heldCount,
        },
        { now, minLeadMinutes: clinic.minLeadMinutes, horizon, unavailabilities },
      );

      /* 4. One active booking per patient per slot (§15). */
      const duplicate = await tx.appointment.findFirst({
        where: { patientId, slotId: slot.id, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        select: { id: true },
      });
      assertNoDuplicateForSlot(duplicate !== null);

      /* 5. Per-patient cap: confirmed/arrived bookings + live, unexpired holds. */
      const [activeBookings, activeHolds] = await Promise.all([
        tx.appointment.count({ where: { patientId, status: { in: [...ACTIVE_BOOKING_STATUSES] } } }),
        tx.seatHold.count({ where: { patientId, releasedAt: null, expiresAt: { gt: now } } }),
      ]);
      assertPatientSeatCap(activeBookings + activeHolds, clinic.maxActiveBookingsPerPatient);

      /* 6. THE last-seat guard — atomic test-and-increment (§15). */
      const consuming = await tx.$executeRaw`
        UPDATE slots SET booked_count = booked_count + 1
        WHERE id = ${slot.id}::uuid AND booked_count + held_count < max_patients
      `;
      if (consuming === 0) {
        throw new AppError(409, "SLOT_FULL", "This slot is fully booked.");
      }

      /* 7. The row, its snapshot fields, its timeline event and its audit row. */
      // The shared §3.2 derivation (lib/fee.ts): Day 23 charges this exact
      // number for the order that pays BEFORE this transaction runs.
      const feeAmount = deriveConsultationFee(profile.consultationFee, clinic.defaultConsultationFee);

      const created = await tx.appointment.create({
        data: {
          doctorId: slot.doctorId,
          patientId,
          slotId: slot.id,
          status: $Enums.AppointmentStatus.CONFIRMED,
          doctorName: slot.doctor.fullName,
          feeAmount,
          bookingTime: now,
        },
        select: { id: true, status: true, feeAmount: true, bookingTime: true, createdAt: true },
      });

      // Pay-at-clinic receivable (§17): no gateway ids and no method yet. A
      // zero-fee booking has nothing to collect, so it deliberately has no row
      // (amountPaise > 0 is a database CHECK).
      const payment =
        feeAmount > 0
          ? await tx.payment.create({
              data: {
                appointmentId: created.id,
                patientId,
                amountPaise: feeAmount,
                currency: clinic.currency,
              },
              select: { id: true },
            })
          : null;

      await tx.appointmentHistory.create({
        data: {
          appointmentId: created.id,
          eventType: $Enums.AppointmentEventType.BOOKED,
          fromStatus: null,
          toStatus: $Enums.AppointmentStatus.CONFIRMED,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorName: input.actor.name,
          ip: input.ip ?? null,
          requestId: input.requestId ?? null,
          metadata: { slotId: slot.id, doctorId: slot.doctorId, source: "patient_self_booking" },
        },
      });

      await writeAudit(tx, {
        action: "APPOINTMENT_BOOKED",
        targetType: "appointment",
        targetId: created.id,
        actor: { id: input.actor.id, role: input.actor.role, name: input.actor.name },
        after: {
          status: $Enums.AppointmentStatus.CONFIRMED,
          doctorId: slot.doctorId,
          patientId,
          slotId: slot.id,
          slotDate,
          feeAmount,
          paymentId: payment?.id ?? null,
          paymentStatus: payment === null ? null : $Enums.PaymentStatus.PENDING,
        },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      const patientEmail = await tx.user.findUnique({
        where: { id: patientId },
        select: { email: true, fullName: true },
      });
      if (patientEmail?.email != null) {
        await queueNotification(tx, {
          type: $Enums.NotificationType.APPOINTMENT_BOOKED,
          recipient: patientEmail.email,
          appointmentId: created.id,
          slotId: slot.id,
        });
      }

      return {
        id: created.id,
        doctorId: slot.doctorId,
        doctorName: slot.doctor.fullName,
        patientId,
        slotId: slot.id,
        slotDate,
        startTime: hhmm(slot.startTime),
        endTime: hhmm(slot.endTime),
        status: created.status,
        feeAmount: created.feeAmount,
        bookingTime: created.bookingTime.toISOString(),
        createdAt: created.createdAt.toISOString(),
      };
    });
  } catch (err) {
    // The partial unique index (§15) is the guarantee; the explicit check above
    // is the clean path. If two of this patient's requests still race past it,
    // this maps the constraint violation to the same 409 a client already knows.
    if (isUniqueConstraintViolation(err)) {
      throw new AppError(409, "ALREADY_BOOKED", "You already have a booking for this slot.");
    }
    throw err;
  }
}
