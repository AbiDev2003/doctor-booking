import { $Enums, Prisma } from "../../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../../lib/prisma.js";
import { AppError } from "../../lib/appError.js";
import { utcToLocalDateTime, normalizePhoneToE164, DEFAULT_COUNTRY_CALLING_CODE } from "../../lib/time.js";
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
import type { DeskBookingResult, DeskPatientInputShape } from "../../schemas/staff.js";
import type { ActorContext } from "../doctors/doctor.service.js";

/**
 * plan.md §16/§29 — the desk/walk-in booking path (Day 32).
 *
 * This is Day 19's booking transaction with exactly two deliberate differences:
 *
 *   1. **The patient is chosen at the desk, not from a session.** The body
 *      carries `{ fullName, phone, email? }`; the desk's identity key is the
 *      normalized phone (§16), so an existing patient is reused and a new one
 *      is created as a *provisional* `User` + `PatientProfile` in the same
 *      transaction as the booking.
 *   2. **There is no email-verification gate.** A walk-in has no login to
 *      verify; §16 makes the desk-created record usable for booking. Every
 *      other §5/§8.5/§10/§11/§15 guard is unchanged — capacity, duplicates,
 *      the per-patient cap and the slot's own state still decide.
 *
 * The patient row is locked before the cap is counted, exactly like Day 19, so
 * two desk terminals booking for one phone cannot both slip past the cap. The
 * last-seat decision remains the guarded `UPDATE … WHERE booked + held < max`.
 */

function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function isUniqueViolationOn(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) {
    return target.some((part) => String(part).includes(field));
  }
  return typeof target === "string" && target.includes(field);
}

function toPatientDto(patient: {
  id: string;
  fullName: string;
  email: string | null;
  phone: string;
  isProvisional: boolean;
}) {
  return {
    id: patient.id,
    fullName: patient.fullName,
    phone: patient.phone,
    email: patient.email,
    isProvisional: patient.isProvisional,
  };
}

export interface DeskBookingInput {
  readonly actor: ActorContext;
  readonly slotId: string;
  readonly patient: DeskPatientInputShape;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export async function bookAtDesk(input: DeskBookingInput): Promise<DeskBookingResult> {
  // The route is staff-gated; this is Day 12's double-enforcement so a
  // miswired route can never turn the desk path into patient self-booking.
  if (input.actor.role !== $Enums.UserRole.ADMIN && input.actor.role !== $Enums.UserRole.STAFF) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }

  const phone = normalizePhoneToE164(input.patient.phone, DEFAULT_COUNTRY_CALLING_CODE);
  const fullName = input.patient.fullName.trim();
  const email = input.patient.email ?? null;
  const now = new Date();
  const clinic = await getClinicSettings();
  const horizon = bookingHorizon(utcToLocalDateTime(now, clinic.timezone).date, clinic.bookingHorizonDays);

  try {
    return await prisma.$transaction(async (tx) => {
      /* 1. Find-or-create the patient by phone (§16's identity key). */
      const existing = await tx.patientProfile.findUnique({
        where: { phone },
        select: {
          userId: true,
          phone: true,
          isProvisional: true,
          user: { select: { id: true, role: true, fullName: true, email: true, isDeactivated: true } },
        },
      });

      let patientId: string;
      let patientName: string;
      let patientEmail: string | null;
      let isProvisional: boolean;
      let createdPatient = false;

      if (existing !== null) {
        if (existing.user.role !== $Enums.UserRole.PATIENT) {
          throw new AppError(409, "PHONE_NOT_PATIENT", "That phone number belongs to a non-patient account.");
        }
        if (existing.user.isDeactivated) {
          throw new AppError(409, "PATIENT_DEACTIVATED", "That patient account is deactivated.");
        }
        patientId = existing.user.id;
        patientName = existing.user.fullName;
        patientEmail = existing.user.email;
        isProvisional = existing.isProvisional;
      } else {
        // A different phone but an email already in use is a desk mistake:
        // reusing that account would attach this booking to the wrong person.
        if (email !== null) {
          const emailOwner = await tx.user.findUnique({ where: { email }, select: { id: true } });
          if (emailOwner !== null) {
            throw new AppError(
              409,
              "EMAIL_ALREADY_EXISTS",
              "That email belongs to another account. Search the patient by phone instead.",
            );
          }
        }

        const created = await tx.user.create({
          data: {
            role: $Enums.UserRole.PATIENT,
            fullName,
            email,
            passwordHash: null,
            emailVerifiedAt: null,
            pendingEmail: null,
            isDeactivated: false,
          },
        });
        await tx.patientProfile.create({
          data: {
            userId: created.id,
            phone,
            phoneVerified: false,
            isProvisional: true,
          },
        });

        await writeAudit(tx, {
          action: "PATIENT_CREATED",
          targetType: "user",
          targetId: created.id,
          actor: { id: input.actor.id, role: input.actor.role, name: input.actor.name },
          after: { fullName, phone, email, isProvisional: true, source: "desk_walk_in" },
          ip: input.ip ?? null,
          requestId: input.requestId ?? null,
        });

        patientId = created.id;
        patientName = created.fullName;
        patientEmail = created.email;
        isProvisional = true;
        createdPatient = true;
      }

      /* 2. Lock the patient row, then the §15 cap is safe from read-then-write. */
      const locked = await tx.$queryRaw<{ is_deactivated: boolean }[]>`
        SELECT is_deactivated FROM users WHERE id = ${patientId}::uuid FOR UPDATE
      `;
      const patientRow = locked[0];
      if (!patientRow) {
        throw new AppError(404, "PATIENT_NOT_FOUND", "Patient not found");
      }
      if (patientRow.is_deactivated) {
        throw new AppError(409, "PATIENT_DEACTIVATED", "That patient account is deactivated.");
      }

      /* 3. Load the slot + doctor; re-apply §5 bookability in-transaction. */
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
        throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
      }

      /* 4. Non-capacity guards (§8.5, §10, §11, §12). */
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

      /* 5. One active booking per patient per slot (§15). */
      const duplicate = await tx.appointment.findFirst({
        where: { patientId, slotId: slot.id, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        select: { id: true },
      });
      assertNoDuplicateForSlot(duplicate !== null);

      /* 6. The same per-patient cap as §15 (no desk override). */
      const [activeBookings, activeHolds] = await Promise.all([
        tx.appointment.count({ where: { patientId, status: { in: [...ACTIVE_BOOKING_STATUSES] } } }),
        tx.seatHold.count({ where: { patientId, releasedAt: null, expiresAt: { gt: now } } }),
      ]);
      assertPatientSeatCap(activeBookings + activeHolds, clinic.maxActiveBookingsPerPatient);

      /* 7. THE last-seat guard — atomic test-and-increment (§15). */
      const consuming = await tx.$executeRaw`
        UPDATE slots SET booked_count = booked_count + 1
        WHERE id = ${slot.id}::uuid AND booked_count + held_count < max_patients
      `;
      if (consuming === 0) {
        throw new AppError(409, "SLOT_FULL", "This slot is fully booked.");
      }

      /* 8. The row, its snapshot fields, timeline, receivable and audit. */
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
          metadata: {
            slotId: slot.id,
            doctorId: slot.doctorId,
            source: "desk_walk_in",
            patientIsProvisional: isProvisional,
          },
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
          source: "desk_walk_in",
          createdPatient,
          patientIsProvisional: isProvisional,
        },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      if (patientEmail !== null) {
        await queueNotification(tx, {
          type: $Enums.NotificationType.APPOINTMENT_BOOKED,
          recipient: patientEmail,
          appointmentId: created.id,
          slotId: slot.id,
        });
      }

      return {
        appointment: {
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
        },
        patient: toPatientDto({
          id: patientId,
          fullName: patientName,
          email: patientEmail,
          phone,
          isProvisional,
        }),
        createdPatient,
      };
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      if (isUniqueViolationOn(err, "phone")) {
        throw new AppError(
          409,
          "PHONE_ALREADY_EXISTS",
          "A patient with that phone was created by another desk terminal. Search again.",
        );
      }
      if (isUniqueViolationOn(err, "email")) {
        throw new AppError(409, "EMAIL_ALREADY_EXISTS", "That email is already registered.");
      }
      throw new AppError(409, "ALREADY_BOOKED", "That patient already has a booking for this slot.");
    }
    throw err;
  }
}
