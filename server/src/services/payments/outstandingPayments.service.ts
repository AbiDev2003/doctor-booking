import { $Enums } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { utcToLocalDateTime } from "../../lib/time.js";
import { getClinicSettings } from "../clinic.service.js";
import type {
  OutstandingDueState,
  OutstandingPaymentDto,
  OutstandingPaymentsDto,
} from "../../schemas/payments.js";

/**
 * Outstanding receivables shared by the front desk and the admin dashboard.
 *
 * A "receivable" is a PENDING payment attached to an appointment — a hold's
 * unpaid order has no appointment and is therefore not money anyone owes. The
 * due classification uses the clinic's calendar day (not the server's), and
 * overdue rows stay in the list until the desk collects or voids them, which is
 * the whole point of the approved Outstanding tab.
 */

const LIVE_APPOINTMENT_STATUSES = [
  $Enums.AppointmentStatus.CONFIRMED,
  $Enums.AppointmentStatus.ARRIVED,
  $Enums.AppointmentStatus.COMPLETED,
  $Enums.AppointmentStatus.NO_SHOW,
] as const;

function ymd(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function dueStateOf(slotDate: string, today: string): OutstandingDueState {
  if (slotDate < today) return "OVERDUE";
  if (slotDate === today) return "TODAY";
  return "UPCOMING";
}

export async function listOutstandingPayments(input: {
  readonly limit: number;
}): Promise<OutstandingPaymentsDto> {
  const clinic = await getClinicSettings();
  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;

  const rows = await prisma.payment.findMany({
    where: {
      status: $Enums.PaymentStatus.PENDING,
      appointmentId: { not: null },
      appointment: { status: { in: [...LIVE_APPOINTMENT_STATUSES] } },
    },
    orderBy: [{ appointment: { slot: { startAt: "asc" } } }, { createdAt: "asc" }],
    take: input.limit,
    select: {
      id: true,
      appointmentId: true,
      patientId: true,
      amountPaise: true,
      currency: true,
      patient: {
        select: {
          fullName: true,
          patientProfile: { select: { phone: true } },
        },
      },
      appointment: {
        select: {
          status: true,
          doctorName: true,
          slot: {
            select: { slotDate: true, startTime: true, endTime: true, startAt: true },
          },
        },
      },
    },
  });

  const payments: OutstandingPaymentDto[] = [];

  for (const row of rows) {
    // The WHERE clause guarantees both, but Prisma's types still widen them;
    // skipping here keeps the DTO non-nullable without a cast.
    if (row.appointmentId === null || row.appointment === null) continue;

    const slotDate = ymd(row.appointment.slot.slotDate);
    payments.push({
      paymentId: row.id,
      appointmentId: row.appointmentId,
      patientId: row.patientId,
      patientName: row.patient.fullName,
      patientPhone: row.patient.patientProfile?.phone ?? "",
      doctorName: row.appointment.doctorName,
      slotDate,
      startTime: hhmm(row.appointment.slot.startTime),
      endTime: hhmm(row.appointment.slot.endTime),
      slotStartsAt: row.appointment.slot.startAt.toISOString(),
      amountPaise: row.amountPaise,
      currency: row.currency,
      dueState: dueStateOf(slotDate, today),
      appointmentStatus: row.appointment.status,
    });
  }

  const totals = payments.reduce(
    (sum, payment) => {
      sum.count += 1;
      sum.totalPaise += payment.amountPaise;
      if (payment.dueState === "OVERDUE") sum.overduePaise += payment.amountPaise;
      else if (payment.dueState === "TODAY") sum.todayPaise += payment.amountPaise;
      else sum.upcomingPaise += payment.amountPaise;
      return sum;
    },
    { overduePaise: 0, todayPaise: 0, upcomingPaise: 0, totalPaise: 0, count: 0 },
  );

  return { date: today, payments, totals };
}
