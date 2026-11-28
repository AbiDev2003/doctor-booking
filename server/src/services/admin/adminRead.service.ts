import { $Enums } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { appointmentActionFlags, paymentSummaryFor } from "../../lib/appointmentActionFlags.js";
import { localDateTimeToUtc, utcToLocalDateTime } from "../../lib/time.js";
import { getClinicSettings } from "../clinic.service.js";
import { findPatientIds } from "../patients/patientSearch.service.js";
import type {
  AdminAppointmentDto,
  AdminAppointmentsDto,
  AdminNotificationDto,
  AdminNotificationsDto,
  AdminOverviewDto,
  AdminPatientDto,
  AdminPatientsDto,
  AdminPaymentDto,
  AdminPaymentsDto,
  AdminRefundDto,
  AdminRefundsDto,
} from "../../schemas/admin.js";
import type { DeskPatientDto } from "../../schemas/staff.js";

/**
 * plan.md §29 — the admin dashboard's read models (Day 33).
 *
 * The admin sees the whole clinic, so these queries are deliberately
 * clinic-wide and read-only. Every mutation the dashboard offers already has a
 * service and a role gate (doctors, slots, appointments, payments, clinic
 * settings); this file exists only to answer the questions those pages ask
 * before a button is pressed.
 *
 * `Clinic.timezone` remains the runtime authority for "today" (§3.2): the
 * overview and the appointment filter derive their UTC bounds from it, never
 * from the server's own timezone.
 */

const ACTIVE_STATUSES = [
  $Enums.AppointmentStatus.CONFIRMED,
  $Enums.AppointmentStatus.ARRIVED,
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
    orderBy: { createdAt: "desc" as const },
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

function clinicDateRange(date: string, timeZone: string): { start: Date; endExclusive: Date } {
  return {
    start: localDateTimeToUtc({ date, time: "00:00" }, timeZone),
    endExclusive: localDateTimeToUtc({ date: shiftDate(date, 1), time: "00:00" }, timeZone),
  };
}

function toPatientDto(row: LoadedAppointment): DeskPatientDto {
  return {
    id: row.patientId,
    fullName: row.patient.fullName,
    phone: row.patient.patientProfile?.phone ?? "",
    email: row.patient.email,
    isProvisional: row.patient.patientProfile?.isProvisional ?? false,
  };
}

function toAppointmentDto(row: LoadedAppointment, now: Date): AdminAppointmentDto {
  const payment = paymentSummaryFor(row);
  return {
    id: row.id,
    doctorId: row.doctorId,
    doctorName: row.doctorName,
    patientId: row.patientId,
    slotId: row.slotId,
    slotDate: ymd(row.slot.slotDate),
    startTime: hhmm(row.slot.startTime),
    endTime: hhmm(row.slot.endTime),
    status: row.status,
    feeAmount: row.feeAmount,
    bookingTime: row.bookingTime.toISOString(),
    createdAt: row.createdAt.toISOString(),
    patient: toPatientDto(row),
    slotStartsAt: row.slot.startAt.toISOString(),
    slotEndsAt: row.slot.endAt.toISOString(),
    patientName: row.patient.fullName,
    patientPhone: row.patient.patientProfile?.phone ?? "",
    patientEmail: row.patient.email,
    isProvisional: row.patient.patientProfile?.isProvisional ?? false,
    payment,
    ...appointmentActionFlags(row, now, payment),
  };
}

/** GET /admin/overview — today's counts plus the two failure queues. */
export async function getAdminOverview(now: Date = new Date()): Promise<AdminOverviewDto> {
  const clinic = await getClinicSettings();
  const date = utcToLocalDateTime(now, clinic.timezone).date;
  const range = clinicDateRange(date, clinic.timezone);

  const [
    statusGroups,
    collected,
    outstanding,
    doctorRows,
    patientTotal,
    provisionalTotal,
    failedRefunds,
    pendingRefunds,
    failedNotifications,
    pendingNotifications,
    unclosedPast,
  ] = await Promise.all([
    prisma.appointment.groupBy({
      by: ["status"],
      where: { slot: { startAt: { gte: range.start, lt: range.endExclusive } } },
      _count: { _all: true },
    }),
    prisma.payment.aggregate({
      where: {
        status: $Enums.PaymentStatus.PAID,
        paidAt: { gte: range.start, lt: range.endExclusive },
      },
      _sum: { amountPaise: true },
    }),
    prisma.payment.aggregate({
      where: {
        status: $Enums.PaymentStatus.PENDING,
        appointment: { slot: { startAt: { gte: range.start, lt: range.endExclusive } } },
      },
      _sum: { amountPaise: true },
    }),
    prisma.doctorProfile.findMany({
      select: {
        verificationStatus: true,
        suspendedAt: true,
        user: { select: { isDeactivated: true } },
      },
    }),
    prisma.user.count({ where: { role: $Enums.UserRole.PATIENT, isDeactivated: false } }),
    prisma.patientProfile.count({ where: { isProvisional: true } }),
    prisma.refund.count({
      where: {
        status: $Enums.RefundStatus.FAILED,
        OR: [{ gatewayRefundId: { not: null } }, { payment: { orderId: { not: null } } }],
      },
    }),
    prisma.refund.count({
      where: {
        status: $Enums.RefundStatus.PENDING,
        OR: [{ gatewayRefundId: { not: null } }, { payment: { orderId: { not: null } } }],
      },
    }),
    prisma.notification.count({ where: { status: $Enums.NotificationStatus.FAILED } }),
    prisma.notification.count({ where: { status: $Enums.NotificationStatus.PENDING } }),
    prisma.appointment.count({
      where: {
        status: $Enums.AppointmentStatus.CONFIRMED,
        slot: { endAt: { lte: now } },
      },
    }),
  ]);

  const byStatus = new Map(statusGroups.map((row) => [row.status, row._count._all]));
  const count = (status: $Enums.AppointmentStatus): number => byStatus.get(status) ?? 0;

  const verified = doctorRows.filter(
    (row) =>
      row.verificationStatus === $Enums.DoctorVerificationStatus.VERIFIED &&
      row.suspendedAt === null &&
      !row.user.isDeactivated,
  ).length;
  const pendingVerification = doctorRows.filter(
    (row) => row.verificationStatus === $Enums.DoctorVerificationStatus.PENDING_VERIFICATION,
  ).length;
  const suspended = doctorRows.filter((row) => row.suspendedAt !== null).length;
  const archived = doctorRows.filter(
    (row) => row.verificationStatus === $Enums.DoctorVerificationStatus.ARCHIVED,
  ).length;

  const total = statusGroups.reduce((sum, row) => sum + row._count._all, 0);

  return {
    date,
    currency: clinic.currency,
    appointments: {
      total,
      confirmed: count($Enums.AppointmentStatus.CONFIRMED),
      arrived: count($Enums.AppointmentStatus.ARRIVED),
      completed: count($Enums.AppointmentStatus.COMPLETED),
      cancelled: count($Enums.AppointmentStatus.CANCELLED),
      rejected: count($Enums.AppointmentStatus.REJECTED),
      noShow: count($Enums.AppointmentStatus.NO_SHOW),
      unclosedPast,
    },
    money: {
      collectedPaise: collected._sum.amountPaise ?? 0,
      outstandingPaise: outstanding._sum.amountPaise ?? 0,
    },
    doctors: { verified, pendingVerification, suspended, archived },
    patients: { total: patientTotal, provisional: provisionalTotal },
    refunds: { failed: failedRefunds, pending: pendingRefunds },
    notifications: { failed: failedNotifications, pending: pendingNotifications },
  };
}

/** GET /admin/patients — the clinic's patient roster, newest first. */
export async function listAdminPatients(input: {
  readonly search?: string | undefined;
  readonly limit: number;
}): Promise<AdminPatientsDto> {
  // Search is shared with the desk: digits look up a phone prefix, text uses
  // pg_trgm fuzzy names, so "abonash" still finds Abinash/Avinash/Abhinash.
  const matchIds =
    input.search !== undefined && input.search !== ""
      ? await findPatientIds(input.search, input.limit)
      : null;

  if (matchIds !== null && matchIds.length === 0) return { patients: [] };

  const rows = await prisma.user.findMany({
    where: {
      role: $Enums.UserRole.PATIENT,
      ...(matchIds !== null && { id: { in: matchIds } }),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    select: {
      id: true,
      fullName: true,
      email: true,
      isDeactivated: true,
      createdAt: true,
      patientProfile: { select: { phone: true, isProvisional: true } },
    },
  });

  // Preserve relevance order for a search (similarity DESC, then recency).
  if (matchIds !== null) {
    const rank = new Map(matchIds.map((id, index) => [id, index]));
    rows.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }

  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { patients: [] };

  const now = new Date();
  const [statusCounts, upcomingCounts, completedVisits] = await Promise.all([
    prisma.appointment.groupBy({
      by: ["patientId", "status"],
      where: { patientId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.appointment.groupBy({
      by: ["patientId"],
      where: {
        patientId: { in: ids },
        status: { in: [...ACTIVE_STATUSES] },
        slot: { startAt: { gte: now } },
      },
      _count: { _all: true },
    }),
    prisma.appointment.findMany({
      where: { patientId: { in: ids }, status: $Enums.AppointmentStatus.COMPLETED },
      select: { patientId: true, slot: { select: { slotDate: true } } },
      orderBy: { slot: { slotDate: "desc" } },
    }),
  ]);

  const completed = new Map<string, number>();
  const noShows = new Map<string, number>();
  for (const row of statusCounts) {
    if (row.status === $Enums.AppointmentStatus.COMPLETED) {
      completed.set(row.patientId, row._count._all);
    } else if (row.status === $Enums.AppointmentStatus.NO_SHOW) {
      noShows.set(row.patientId, row._count._all);
    }
  }

  const upcoming = new Map(upcomingCounts.map((row) => [row.patientId, row._count._all]));
  const lastVisit = new Map<string, string>();
  for (const row of completedVisits) {
    if (!lastVisit.has(row.patientId)) {
      lastVisit.set(row.patientId, ymd(row.slot.slotDate));
    }
  }

  const patients: AdminPatientDto[] = rows.map((row) => {
    const completedCount = completed.get(row.id) ?? 0;
    return {
      id: row.id,
      fullName: row.fullName,
      phone: row.patientProfile?.phone ?? "",
      email: row.email,
      isProvisional: row.patientProfile?.isProvisional ?? false,
      isDeactivated: row.isDeactivated,
      createdAt: row.createdAt.toISOString(),
      completedCount,
      noShowCount: noShows.get(row.id) ?? 0,
      upcomingCount: upcoming.get(row.id) ?? 0,
      lastVisitDate: lastVisit.get(row.id) ?? null,
      returning: completedCount > 0,
    };
  });

  return { patients };
}

/**
 * The shared, filterable, desk-shaped read over every booking.
 *
 * Both the admin History route and the staff History route call this function;
 * the role gates live in the routes, and the action flags come from the one
 * shared helper, so the two dashboards cannot disagree about what is closeable.
 */
export async function listClinicAppointmentHistory(input: {
  readonly date?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly scope?: "all" | "upcoming" | "past" | "needsAttention" | undefined;
  readonly status?: $Enums.AppointmentStatus | undefined;
  readonly doctorId?: string | undefined;
  readonly search?: string | undefined;
  readonly limit: number;
}): Promise<AdminAppointmentsDto> {
  const clinic = await getClinicSettings();
  const now = new Date();
  const dateRange = input.date === undefined ? null : clinicDateRange(input.date, clinic.timezone);
  const fromRange = input.from === undefined ? null : clinicDateRange(input.from, clinic.timezone);
  const toRange = input.to === undefined ? null : clinicDateRange(input.to, clinic.timezone);

  const startAt: Prisma.DateTimeFilter = {};
  if (dateRange !== null) {
    startAt.gte = dateRange.start;
    startAt.lt = dateRange.endExclusive;
  }
  if (fromRange !== null) startAt.gte = fromRange.start;
  if (toRange !== null) startAt.lt = toRange.endExclusive;

  const slotWhere: Prisma.SlotWhereInput = {};
  if (Object.keys(startAt).length > 0) slotWhere.startAt = startAt;
  if (input.scope === "upcoming") slotWhere.endAt = { gt: now };
  if (input.scope === "past" || input.scope === "needsAttention") slotWhere.endAt = { lte: now };

  const patientIds =
    input.search === undefined || input.search.trim() === ""
      ? null
      : await findPatientIds(input.search, input.limit);

  const status = input.scope === "needsAttention" ? $Enums.AppointmentStatus.CONFIRMED : input.status;
  const where: Prisma.AppointmentWhereInput = {
    ...(status !== undefined && { status }),
    ...(input.doctorId !== undefined && { doctorId: input.doctorId }),
    ...(Object.keys(slotWhere).length > 0 && { slot: slotWhere }),
    ...(patientIds !== null && { patientId: { in: patientIds } }),
  };

  const rows = await prisma.appointment.findMany({
    where,
    orderBy: [{ slot: { startAt: "desc" } }, { bookingTime: "desc" }],
    take: input.limit,
    select: APPOINTMENT_SELECT,
  });

  return { appointments: rows.map((row) => toAppointmentDto(row, now)) };
}

/** Historical name kept for the admin route; same behaviour as the shared read. */
export const listAdminAppointments = listClinicAppointmentHistory;

/** GET /admin/payments — every payment in the clinic, newest first. */
export async function listAdminPayments(input: {
  readonly status?: $Enums.PaymentStatus | undefined;
  readonly method?: $Enums.PaymentMethod | undefined;
  readonly limit: number;
}): Promise<AdminPaymentsDto> {
  const rows = await prisma.payment.findMany({
    where: {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.method !== undefined && { method: input.method }),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    select: {
      id: true,
      appointmentId: true,
      patientId: true,
      amountPaise: true,
      currency: true,
      status: true,
      method: true,
      paidAt: true,
      createdAt: true,
      patient: {
        select: {
          fullName: true,
          patientProfile: { select: { phone: true } },
        },
      },
      collectedBy: { select: { fullName: true } },
      appointment: {
        select: {
          doctorName: true,
          slot: { select: { slotDate: true, startTime: true, endTime: true } },
        },
      },
      refunds: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          kind: true,
          amountPaise: true,
          status: true,
          method: true,
          reason: true,
          createdAt: true,
        },
      },
    },
  });

  const payments: AdminPaymentDto[] = rows.map((row) => ({
    id: row.id,
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    patientName: row.patient.fullName,
    patientPhone: row.patient.patientProfile?.phone ?? "",
    doctorName: row.appointment?.doctorName ?? null,
    slotDate: row.appointment ? ymd(row.appointment.slot.slotDate) : null,
    startTime: row.appointment ? hhmm(row.appointment.slot.startTime) : null,
    endTime: row.appointment ? hhmm(row.appointment.slot.endTime) : null,
    amountPaise: row.amountPaise,
    currency: row.currency,
    status: row.status,
    method: row.method,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    collectedByName: row.collectedBy?.fullName ?? null,
    refunds: row.refunds.map((refund) => ({
      id: refund.id,
      kind: refund.kind,
      amountPaise: refund.amountPaise,
      status: refund.status,
      method: refund.method,
      reason: refund.reason,
      createdAt: refund.createdAt.toISOString(),
    })),
  }));

  return { payments };
}

/** GET /admin/refunds — gateway refunds needing retry/review. */
export async function listAdminRefunds(input: {
  readonly status: $Enums.RefundStatus;
  readonly limit: number;
}): Promise<AdminRefundsDto> {
  const rows = await prisma.refund.findMany({
    where: {
      status: input.status,
      OR: [{ gatewayRefundId: { not: null } }, { payment: { orderId: { not: null } } }],
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    select: {
      id: true,
      paymentId: true,
      amountPaise: true,
      kind: true,
      status: true,
      method: true,
      reason: true,
      gatewayRefundId: true,
      actorName: true,
      createdAt: true,
      payment: {
        select: {
          appointmentId: true,
          patientId: true,
          currency: true,
          patient: { select: { fullName: true } },
        },
      },
    },
  });

  const refunds: AdminRefundDto[] = rows.map((row) => ({
    id: row.id,
    paymentId: row.paymentId,
    appointmentId: row.payment.appointmentId,
    patientId: row.payment.patientId,
    patientName: row.payment.patient.fullName,
    amountPaise: row.amountPaise,
    currency: row.payment.currency,
    kind: row.kind,
    status: row.status,
    method: row.method,
    reason: row.reason,
    gatewayRefundId: row.gatewayRefundId,
    actorName: row.actorName,
    createdAt: row.createdAt.toISOString(),
  }));

  return { refunds };
}

/** GET /admin/notifications — the delivery feed, failures first when filtered. */
export async function listAdminNotifications(input: {
  readonly status?: $Enums.NotificationStatus | undefined;
  readonly type?: string | undefined;
  readonly limit: number;
}): Promise<AdminNotificationsDto> {
  const rows = await prisma.notification.findMany({
    where: {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.type !== undefined && { type: input.type as $Enums.NotificationType }),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    select: {
      id: true,
      type: true,
      status: true,
      recipient: true,
      appointmentId: true,
      error: true,
      sentAt: true,
      createdAt: true,
    },
  });

  const notifications: AdminNotificationDto[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    recipient: row.recipient,
    appointmentId: row.appointmentId,
    error: row.error,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));

  return { notifications };
}
