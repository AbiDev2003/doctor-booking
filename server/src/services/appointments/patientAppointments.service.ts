import { $Enums } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/appError.js";
import { isClinicCaused } from "../../lib/unavailability.js";
import { patientCancelBlockReason } from "../../lib/transitionGuard.js";
import { remainingRefundablePaise } from "../../lib/refundPolicy.js";
import { getClinicSettings } from "../clinic.service.js";
import type {
  AppointmentDto,
  CancellationPreviewDto,
  ListAppointmentsScope,
  PatientAppointmentDto,
} from "../../schemas/appointments.js";

/**
 * plan.md §27 / §28 — the patient dashboard's read model (Day 30).
 *
 * Read-only by design: cancel and reschedule still go through Day 21/22's
 * services, which re-read and re-judge inside their own transactions. This file
 * only answers "what does this patient own, and which actions are open right
 * now", so the UI does not have to re-derive §8.5's cutoff or §12's
 * clinic-caused waiver (a drift there would promise a refund the server will
 * not make).
 *
 * Every query is scoped by `patientId` from `req.user`; there is no route that
 * accepts another patient's id.
 */

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` a client renders. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/** `@db.Date` read back at UTC midnight → `YYYY-MM-DD`. */
function ymd(value: Date): string {
  return value.toISOString().slice(0, 10);
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
  slot: {
    select: { slotDate: true, startTime: true, endTime: true, startAt: true, endAt: true },
  },
} satisfies Prisma.AppointmentSelect;

type LoadedAppointment = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>;

function toBaseDto(appointment: LoadedAppointment): AppointmentDto {
  return {
    id: appointment.id,
    doctorId: appointment.doctorId,
    doctorName: appointment.doctorName,
    patientId: appointment.patientId,
    slotId: appointment.slotId,
    slotDate: ymd(appointment.slot.slotDate),
    startTime: hhmm(appointment.slot.startTime),
    endTime: hhmm(appointment.slot.endTime),
    status: appointment.status,
    feeAmount: appointment.feeAmount,
    bookingTime: appointment.bookingTime.toISOString(),
    createdAt: appointment.createdAt.toISOString(),
  };
}

function toPatientDto(
  appointment: LoadedAppointment,
  now: Date,
  cancelCutoffMinutes: number,
): PatientAppointmentDto {
  const clinicCaused = isClinicCaused(appointment);
  const cancelBlockedReason = patientCancelBlockReason(
    appointment.slot.startAt,
    now,
    cancelCutoffMinutes,
    clinicCaused,
  );
  const actionable = appointment.status === $Enums.AppointmentStatus.CONFIRMED && cancelBlockedReason === null;

  return {
    ...toBaseDto(appointment),
    slotStartsAt: appointment.slot.startAt.toISOString(),
    slotEndsAt: appointment.slot.endAt.toISOString(),
    clinicCaused,
    canCancel: actionable,
    canReschedule: actionable,
    cancelBlockedReason,
  };
}

/**
 * The patient's own appointments, filtered by a presentation scope.
 *
 * `upcoming` = still in a seat-holding status and the slot has not ended;
 * `past` = everything else (terminal states plus windows that have ended).
 * That split keeps a cancelled future booking out of "upcoming" while still
 * showing a same-day ARRIVED booking as current until its window closes.
 */
export async function listPatientAppointments(input: {
  readonly patientId: string;
  readonly scope: ListAppointmentsScope;
}): Promise<{ appointments: PatientAppointmentDto[] }> {
  const now = new Date();
  const clinic = await getClinicSettings();

  const scopeWhere: Prisma.AppointmentWhereInput =
    input.scope === "upcoming"
      ? {
          status: { in: [$Enums.AppointmentStatus.CONFIRMED, $Enums.AppointmentStatus.ARRIVED] },
          slot: { endAt: { gt: now } },
        }
      : input.scope === "past"
        ? {
            OR: [
              { status: { notIn: [$Enums.AppointmentStatus.CONFIRMED, $Enums.AppointmentStatus.ARRIVED] } },
              { slot: { endAt: { lte: now } } },
            ],
          }
        : {};

  const rows = await prisma.appointment.findMany({
    where: { patientId: input.patientId, ...scopeWhere },
    select: APPOINTMENT_SELECT,
    orderBy: { slot: { startAt: input.scope === "past" ? "desc" : "asc" } },
  });

  return {
    appointments: rows.map((row) => toPatientDto(row, now, clinic.cancelCutoffMinutes)),
  };
}

async function loadOwnedAppointment(appointmentId: string, patientId: string): Promise<LoadedAppointment> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: APPOINTMENT_SELECT,
  });
  if (appointment === null) {
    throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
  }
  // The same generic 403 as every ownership check (§7): a probe cannot tell a
  // missing row from someone else's.
  if (appointment.patientId !== patientId) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
  return appointment;
}

/** One appointment, still scoped to the signed-in patient (deep links on the dashboard). */
export async function getPatientAppointment(input: {
  readonly appointmentId: string;
  readonly patientId: string;
}): Promise<PatientAppointmentDto> {
  const appointment = await loadOwnedAppointment(input.appointmentId, input.patientId);
  const clinic = await getClinicSettings();
  return toPatientDto(appointment, new Date(), clinic.cancelCutoffMinutes);
}

/**
 * What cancelling would do, computed with the SAME rules the cancel service
 * applies (status, §8.5 cutoff, clinic-caused waiver, §17 refund amount). The
 * preview writes nothing — the cancel route remains the only mutation.
 */
export async function previewCancellation(input: {
  readonly appointmentId: string;
  readonly patientId: string;
}): Promise<CancellationPreviewDto> {
  const appointment = await loadOwnedAppointment(input.appointmentId, input.patientId);
  const clinic = await getClinicSettings();
  const now = new Date();
  const clinicCaused = isClinicCaused(appointment);

  const cancelBlockedReason =
    appointment.status === $Enums.AppointmentStatus.CONFIRMED
      ? patientCancelBlockReason(appointment.slot.startAt, now, clinic.cancelCutoffMinutes, clinicCaused)
      : `An appointment in ${appointment.status} cannot be cancelled.`;
  const canCancel = cancelBlockedReason === null;

  const paymentSelect = {
    id: true,
    amountPaise: true,
    status: true,
    method: true,
    paymentId: true,
    refunds: { select: { amountPaise: true } },
  } satisfies Prisma.PaymentSelect;

  const payment =
    (await prisma.payment.findFirst({
      where: { appointmentId: appointment.id, status: $Enums.PaymentStatus.PAID },
      orderBy: { createdAt: "desc" },
      select: paymentSelect,
    })) ??
    (await prisma.payment.findFirst({
      where: { appointmentId: appointment.id, status: $Enums.PaymentStatus.PENDING },
      orderBy: { createdAt: "desc" },
      select: paymentSelect,
    }));

  let refundAmountPaise = 0;
  let refundSettlement: CancellationPreviewDto["refundSettlement"] = "none";

  if (payment !== null && payment.status === $Enums.PaymentStatus.PAID && canCancel) {
    refundAmountPaise = remainingRefundablePaise(payment.amountPaise, payment.refunds);
    if (refundAmountPaise > 0) {
      // No gateway id means pay-at-clinic: a human hands the money back (§17).
      refundSettlement = payment.paymentId === null ? "desk" : "automatic";
    }
  }

  const cutoffAt = clinicCaused
    ? null
    : new Date(appointment.slot.startAt.getTime() - clinic.cancelCutoffMinutes * 60_000).toISOString();

  return {
    appointmentId: appointment.id,
    canCancel,
    cancelBlockedReason,
    clinicCaused,
    slotStartsAt: appointment.slot.startAt.toISOString(),
    cutoffAt,
    payment:
      payment === null
        ? null
        : {
            id: payment.id,
            amountPaise: payment.amountPaise,
            status: payment.status,
            method: payment.method,
          },
    refundAmountPaise,
    refundSettlement,
  };
}
