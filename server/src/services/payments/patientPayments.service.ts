import { prisma } from "../../lib/prisma.js";
import type { PatientPaymentDto } from "../../schemas/payments.js";

/**
 * plan.md §27 — the patient's payment history (Day 30).
 *
 * Read-only and patient-scoped: the only filter is the `patientId` from
 * `req.user`, so there is no route shape that can ask for someone else's money.
 * Hold orders that never converted have no appointment and no slot to show, so
 * they are filtered out; what remains is the patient's receivables, paid
 * bookings and every refund attached to them (§17).
 */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

export async function listPatientPayments(input: {
  readonly patientId: string;
}): Promise<{ payments: PatientPaymentDto[] }> {
  const rows = await prisma.payment.findMany({
    where: { patientId: input.patientId, appointmentId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      appointmentId: true,
      amountPaise: true,
      currency: true,
      status: true,
      method: true,
      paidAt: true,
      createdAt: true,
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

  return {
    payments: rows.map((row) => ({
      id: row.id,
      appointmentId: row.appointmentId,
      amountPaise: row.amountPaise,
      currency: row.currency,
      status: row.status,
      method: row.method,
      paidAt: row.paidAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      doctorName: row.appointment?.doctorName ?? null,
      slotDate: row.appointment?.slot.slotDate.toISOString().slice(0, 10) ?? null,
      startTime: row.appointment ? hhmm(row.appointment.slot.startTime) : null,
      endTime: row.appointment ? hhmm(row.appointment.slot.endTime) : null,
      refunds: row.refunds.map((refund) => ({
        id: refund.id,
        kind: refund.kind,
        amountPaise: refund.amountPaise,
        status: refund.status,
        method: refund.method,
        reason: refund.reason,
        createdAt: refund.createdAt.toISOString(),
      })),
    })),
  };
}
