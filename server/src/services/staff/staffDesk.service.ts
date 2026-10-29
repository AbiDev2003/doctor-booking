import { $Enums } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { localDateTimeToUtc, utcToLocalDateTime, normalizePhoneToE164, DEFAULT_COUNTRY_CALLING_CODE } from "../../lib/time.js";
import { getClinicSettings } from "../clinic.service.js";
import type {
  DeskAppointmentActions,
  DeskAppointmentEntry,
  DeskPatientDto,
  DeskPaymentSummary,
  DeskQueueDto,
  DeskSlotQueue,
  PatientSummaryDto,
  VisitHistoryDto,
} from "../../schemas/staff.js";

/**
 * plan.md §16/§29 — the front desk's read model (Day 32).
 *
 * The desk sees the WHOLE clinic day, not one doctor's queue: today's slots for
 * every doctor, each with the bookings waiting in it, plus the server-computed
 * action flags the attendance buttons depend on. The day boundary is the
 * clinic's own timezone (§3.2), so a UTC server never splits a clinic session.
 *
 * The visit-history half is §16's returning-patient lookup. Phone is the
 * identity key (normalized exactly as registration normalizes it), name is a
 * display hint, and "returning" means at least one COMPLETED appointment — a
 * cancelled or no-show booking is not a visit.
 */

const QUEUE_STATUSES = [
  $Enums.AppointmentStatus.CONFIRMED,
  $Enums.AppointmentStatus.ARRIVED,
  $Enums.AppointmentStatus.COMPLETED,
  $Enums.AppointmentStatus.NO_SHOW,
] as const;

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
  patient: {
    select: {
      id: true,
      fullName: true,
      email: true,
      patientProfile: { select: { phone: true, isProvisional: true } },
    },
  },
  slot: {
    select: { slotDate: true, startTime: true, endTime: true, startAt: true, endAt: true },
  },
  payments: {
    select: { amountPaise: true, status: true, method: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  },
} satisfies Prisma.AppointmentSelect;

type LoadedAppointment = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>;

function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function ymd(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The UTC bounds of one clinic-local calendar day. */
function clinicDateRange(date: string, timeZone: string): { start: Date; endExclusive: Date } {
  const next = shiftDate(date, 1);
  return {
    start: localDateTimeToUtc({ date, time: "00:00" }, timeZone),
    endExclusive: localDateTimeToUtc({ date: next, time: "00:00" }, timeZone),
  };
}

function statusLabel(status: $Enums.AppointmentStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function paymentSummary(appointment: LoadedAppointment): DeskPaymentSummary {
  let outstandingPaise = 0;
  let paidPaise = 0;
  let method: $Enums.PaymentMethod | null = null;

  for (const payment of appointment.payments) {
    if (payment.status === $Enums.PaymentStatus.PENDING) {
      outstandingPaise += payment.amountPaise;
    } else if (payment.status === $Enums.PaymentStatus.PAID) {
      paidPaise += payment.amountPaise;
      method ??= payment.method;
    }
  }

  return {
    status: outstandingPaise > 0 ? "PENDING" : paidPaise > 0 ? "PAID" : "NONE",
    outstandingPaise,
    paidPaise,
    method,
  };
}

/**
 * The action flags, from the same rules the transition services enforce.
 *
 * `canComplete` includes the §13.1 payment wall for the same reason the service
 * refuses the transition: a visit cannot close while a receivable is pending.
 * Cancel/reschedule have no clock wall for staff (§8.5): the desk may always
 * close a booking with a reason.
 */
function actionFlags(
  appointment: LoadedAppointment,
  now: Date,
  payment: DeskPaymentSummary,
): DeskAppointmentActions {
  const status = appointment.status;
  const { startAt, endAt } = appointment.slot;
  const label = statusLabel(status);

  const canArrive = status === $Enums.AppointmentStatus.CONFIRMED && now.getTime() >= startAt.getTime();
  const canComplete = status === $Enums.AppointmentStatus.ARRIVED && payment.outstandingPaise === 0;
  const canNoShow =
    status === $Enums.AppointmentStatus.CONFIRMED &&
    now.getTime() >= endAt.getTime() &&
    payment.outstandingPaise === 0;
  const canReject = status === $Enums.AppointmentStatus.CONFIRMED;
  const canCancel =
    status === $Enums.AppointmentStatus.CONFIRMED || status === $Enums.AppointmentStatus.ARRIVED;
  const canReschedule = status === $Enums.AppointmentStatus.CONFIRMED;

  return {
    canArrive,
    canComplete,
    canNoShow,
    canReject,
    canCancel,
    canReschedule,
    arriveBlockedReason: canArrive
      ? null
      : status !== $Enums.AppointmentStatus.CONFIRMED
        ? `Only a confirmed booking can be checked in (this one is ${label.toLowerCase()}).`
        : "Check-in opens when the slot starts.",
    completeBlockedReason: canComplete
      ? null
      : status !== $Enums.AppointmentStatus.ARRIVED
        ? `Only an arrived booking can be completed (this one is ${label.toLowerCase()}).`
        : "Collect or void the pending payment before completing the visit.",
    noShowBlockedReason: canNoShow
      ? null
      : status !== $Enums.AppointmentStatus.CONFIRMED
        ? `Only a confirmed booking can be marked no-show (this one is ${label.toLowerCase()}).`
        : now.getTime() < endAt.getTime()
          ? "No-show can be recorded after the slot ends."
          : "Collect or void the pending payment before closing the visit.",
    cancelBlockedReason: canCancel ? null : `This booking is already ${label.toLowerCase()}.`,
    rescheduleBlockedReason: canReschedule
      ? null
      : `Only a confirmed booking can be rescheduled (this one is ${label.toLowerCase()}).`,
  };
}

function toPatientDto(appointment: LoadedAppointment): DeskPatientDto {
  return {
    id: appointment.patient.id,
    fullName: appointment.patient.fullName,
    phone: appointment.patient.patientProfile?.phone ?? "",
    email: appointment.patient.email,
    isProvisional: appointment.patient.patientProfile?.isProvisional ?? false,
  };
}

function toEntry(appointment: LoadedAppointment, now: Date): DeskAppointmentEntry {
  const payment = paymentSummary(appointment);
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
    patient: toPatientDto(appointment),
    slotStartsAt: appointment.slot.startAt.toISOString(),
    slotEndsAt: appointment.slot.endAt.toISOString(),
    payment,
    ...actionFlags(appointment, now, payment),
  };
}

/**
 * GET /appointments/desk — one clinic day, every doctor, every slot.
 *
 * Slots with no bookings are included deliberately: the desk needs to see the
 * afternoon it still has seats for, not only the patients already booked.
 */
export async function listDeskQueue(date?: string): Promise<DeskQueueDto> {
  const clinic = await getClinicSettings();
  const day = date ?? utcToLocalDateTime(new Date(), clinic.timezone).date;
  const range = clinicDateRange(day, clinic.timezone);
  const now = new Date();

  const [slots, rows] = await Promise.all([
    prisma.slot.findMany({
      where: { startAt: { gte: range.start, lt: range.endExclusive } },
      select: {
        id: true,
        doctorId: true,
        slotDate: true,
        startTime: true,
        endTime: true,
        startAt: true,
        endAt: true,
        maxPatients: true,
        bookedCount: true,
        heldCount: true,
        isDisabled: true,
        doctor: { select: { fullName: true } },
      },
      orderBy: [{ startAt: "asc" }, { doctor: { fullName: "asc" } }],
    }),
    prisma.appointment.findMany({
      where: {
        slot: { startAt: { gte: range.start, lt: range.endExclusive } },
        status: { in: [...QUEUE_STATUSES] },
      },
      select: APPOINTMENT_SELECT,
      orderBy: [{ slot: { startAt: "asc" } }, { bookingTime: "asc" }],
    }),
  ]);

  const bySlot = new Map<string, DeskAppointmentEntry[]>();
  for (const row of rows) {
    const entries = bySlot.get(row.slotId) ?? [];
    entries.push(toEntry(row, now));
    bySlot.set(row.slotId, entries);
  }

  const slotQueues: DeskSlotQueue[] = slots.map((slot) => ({
    slotId: slot.id,
    doctorId: slot.doctorId,
    doctorName: slot.doctor.fullName,
    slotDate: ymd(slot.slotDate),
    startTime: hhmm(slot.startTime),
    endTime: hhmm(slot.endTime),
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    maxPatients: slot.maxPatients,
    bookedCount: slot.bookedCount,
    heldCount: slot.heldCount,
    isDisabled: slot.isDisabled,
    appointments: bySlot.get(slot.id) ?? [],
  }));

  return { date: day, slots: slotQueues };
}

function toPatientSummary(row: {
  id: string;
  fullName: string;
  email: string | null;
  isDeactivated: boolean;
  createdAt: Date;
  patientProfile: { phone: string; isProvisional: boolean } | null;
}): PatientSummaryDto {
  return {
    id: row.id,
    fullName: row.fullName,
    phone: row.patientProfile?.phone ?? "",
    email: row.email,
    isProvisional: row.patientProfile?.isProvisional ?? false,
    isDeactivated: row.isDeactivated,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET /patients/visit-history — §16's lookup.
 *
 * A phone the clinic has never seen returns `found: false` with empty metrics
 * rather than a 404: "new patient" is a normal front-desk answer, and the UI
 * uses it to offer the walk-in form.
 */
export async function getPatientVisitHistory(rawPhone: string): Promise<VisitHistoryDto> {
  const phone = normalizePhoneToE164(rawPhone, DEFAULT_COUNTRY_CALLING_CODE);

  const profile = await prisma.patientProfile.findUnique({
    where: { phone },
    select: {
      phone: true,
      isProvisional: true,
      user: {
        select: { id: true, fullName: true, email: true, isDeactivated: true, createdAt: true, role: true },
      },
    },
  });

  if (profile === null || profile.user.role !== $Enums.UserRole.PATIENT) {
    return {
      found: false,
      patient: null,
      returning: false,
      completedCount: 0,
      noShowCount: 0,
      upcomingCount: 0,
      lastVisitDate: null,
      doctorsSeen: [],
      upcomingAppointments: [],
    };
  }

  const patientId = profile.user.id;
  const now = new Date();

  const [completedCount, noShowCount, lastVisit, doctors, upcoming] = await Promise.all([
    prisma.appointment.count({
      where: { patientId, status: $Enums.AppointmentStatus.COMPLETED },
    }),
    prisma.appointment.count({
      where: { patientId, status: $Enums.AppointmentStatus.NO_SHOW },
    }),
    prisma.appointment.findFirst({
      where: { patientId, status: $Enums.AppointmentStatus.COMPLETED },
      select: { slot: { select: { slotDate: true } } },
      orderBy: { slot: { startAt: "desc" } },
    }),
    prisma.appointment.findMany({
      where: { patientId, status: $Enums.AppointmentStatus.COMPLETED },
      select: { doctorName: true },
      distinct: ["doctorName"],
      orderBy: { doctorName: "asc" },
    }),
    prisma.appointment.findMany({
      where: {
        patientId,
        status: { in: [$Enums.AppointmentStatus.CONFIRMED, $Enums.AppointmentStatus.ARRIVED] },
        slot: { endAt: { gt: now } },
      },
      select: APPOINTMENT_SELECT,
      orderBy: [{ slot: { startAt: "asc" } }, { bookingTime: "asc" }],
    }),
  ]);

  return {
    found: true,
    patient: toPatientSummary({
      id: profile.user.id,
      fullName: profile.user.fullName,
      email: profile.user.email,
      isDeactivated: profile.user.isDeactivated,
      createdAt: profile.user.createdAt,
      patientProfile: { phone: profile.phone, isProvisional: profile.isProvisional },
    }),
    returning: completedCount > 0,
    completedCount,
    noShowCount,
    upcomingCount: upcoming.length,
    lastVisitDate: lastVisit === null ? null : ymd(lastVisit.slot.slotDate),
    doctorsSeen: doctors.map((row) => row.doctorName),
    upcomingAppointments: upcoming.map((row) => toEntry(row, now)),
  };
}
