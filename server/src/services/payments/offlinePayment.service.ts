import { $Enums } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/appError.js";
import { resolveCollectedAmount } from "../../lib/offlinePayment.js";
import { writeAudit } from "../audit.service.js";
import type { AuditActor } from "../audit.service.js";
import { queueNotification } from "../notifications/notification.service.js";
import type { OfflinePaymentDto } from "../../schemas/payments.js";
import type { ActorContext } from "../doctor.service.js";
import type { DbClient } from "../../lib/prisma.js";

/**
 * plan.md §17 — pay-at-clinic money at the desk, Day 26.
 *
 * The booking transaction creates a `PENDING` `Payment` with no gateway ids and
 * no method. This service is the only thing that turns that receivable into
 * cash/card/UPI income (`collectOfflinePayment`) or writes it off
 * (`voidPendingPaymentForAppointment`). Nothing here calls a gateway: the money
 * is physically at the desk, so the staff member's report is the proof and the
 * audit trail is the receipt.
 *
 * `collectOfflinePayment` locks the appointment row first. Cancellation and
 * auto-cancel void the receivable inside their own transaction, so the lock
 * makes "collect" and "cancel" serialize: either the collection wins and the
 * cancel sees PAID (queueing a hand-back), or the cancel wins and the
 * collection sees CANCELLED and refuses.
 */

function assertDeskActor(actor: ActorContext): void {
  if (actor.role !== $Enums.UserRole.ADMIN && actor.role !== $Enums.UserRole.STAFF) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
}

export interface CollectOfflinePaymentInput {
  readonly actor: ActorContext;
  readonly appointmentId: string;
  readonly method: $Enums.PaymentMethod;
  /** The actual amount taken; omitted means the outstanding fee in full. */
  readonly amountPaise?: number | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export interface VoidOfflinePaymentInput {
  readonly actor: ActorContext;
  readonly appointmentId: string;
  readonly reason: string;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export interface VoidPendingForAppointmentInput {
  readonly appointmentId: string;
  readonly reason: string;
  readonly actor: AuditActor;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

interface LockedAppointmentRow {
  readonly status: $Enums.AppointmentStatus;
}

const PAYMENT_SELECT = {
  id: true,
  appointmentId: true,
  patientId: true,
  amountPaise: true,
  currency: true,
  status: true,
  method: true,
  paidAt: true,
  collectedById: true,
  collectedAt: true,
};

type LoadedPayment = {
  id: string;
  appointmentId: string;
  patientId: string;
  amountPaise: number;
  currency: string;
  status: $Enums.PaymentStatus;
  method: $Enums.PaymentMethod | null;
  paidAt: Date | null;
  collectedById: string | null;
  collectedAt: Date | null;
};

function toDto(payment: LoadedPayment & { appointmentId: string }): OfflinePaymentDto {
  return {
    paymentId: payment.id,
    appointmentId: payment.appointmentId,
    patientId: payment.patientId,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    status: payment.status,
    method: payment.method,
    paidAt: payment.paidAt?.toISOString() ?? null,
    collectedById: payment.collectedById,
    collectedAt: payment.collectedAt?.toISOString() ?? null,
  };
}

async function lockAppointment(tx: DbClient, appointmentId: string): Promise<LockedAppointmentRow> {
  const rows = await tx.$queryRaw<LockedAppointmentRow[]>`
    SELECT status FROM appointments WHERE id = ${appointmentId}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
  }
  return row;
}

/**
 * Marks a desk receivable PAID. `amountPaise` defaults to the row's outstanding
 * amount; a smaller supplied amount is a deliberate concession and becomes the
 * amount stored (and therefore the amount refundable), never a second row.
 */
export async function collectOfflinePayment(input: CollectOfflinePaymentInput): Promise<OfflinePaymentDto> {
  assertDeskActor(input.actor);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const appointment = await lockAppointment(tx, input.appointmentId);
    if (
      appointment.status !== $Enums.AppointmentStatus.CONFIRMED &&
      appointment.status !== $Enums.AppointmentStatus.ARRIVED
    ) {
      throw new AppError(
        409,
        "APPOINTMENT_NOT_PAYABLE",
        `This appointment is ${appointment.status.toLowerCase()} and cannot be collected.`,
      );
    }

    const payment = await tx.payment.findFirst({
      where: {
        appointmentId: input.appointmentId,
        status: $Enums.PaymentStatus.PENDING,
      },
      orderBy: { createdAt: "desc" },
      select: PAYMENT_SELECT,
    });
    if (!payment) {
      throw new AppError(
        409,
        "PAYMENT_NOT_PENDING",
        "This appointment has no pending pay-at-clinic payment to collect.",
      );
    }

    const amountPaise = resolveCollectedAmount(payment.amountPaise, input.amountPaise);

    const updated = await tx.payment.updateMany({
      where: { id: payment.id, status: $Enums.PaymentStatus.PENDING },
      data: {
        status: $Enums.PaymentStatus.PAID,
        amountPaise,
        method: input.method,
        paidAt: now,
        collectedById: input.actor.id,
        collectedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new AppError(409, "PAYMENT_NOT_PENDING", "The payment changed while this request was in flight.");
    }

    const appointmentRow = await tx.appointment.findUnique({
      where: { id: input.appointmentId },
      select: {
        slotId: true,
        patient: { select: { email: true } },
      },
    });

    if (appointmentRow?.patient.email != null) {
      await queueNotification(tx, {
        type: $Enums.NotificationType.PAYMENT_SUCCESSFUL,
        recipient: appointmentRow.patient.email,
        appointmentId: input.appointmentId,
        slotId: appointmentRow.slotId,
      });
    }

    await writeAudit(tx, {
      action: "PAYMENT_COLLECTED",
      targetType: "payment",
      targetId: payment.id,
      actor: { id: input.actor.id, role: input.actor.role, name: input.actor.name },
      before: {
        status: $Enums.PaymentStatus.PENDING,
        amountPaise: payment.amountPaise,
        method: null,
      },
      after: {
        status: $Enums.PaymentStatus.PAID,
        amountPaise,
        method: input.method,
        appointmentId: input.appointmentId,
        collectedById: input.actor.id,
        collectedAt: now.toISOString(),
      },
      reason: "Pay-at-clinic payment collected at the desk",
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return toDto({
      ...payment,
      appointmentId: input.appointmentId,
      amountPaise,
      status: $Enums.PaymentStatus.PAID,
      method: input.method,
      paidAt: now,
      collectedById: input.actor.id,
      collectedAt: now,
    });
  });
}

/**
 * Desk correction: void one appointment's still-unpaid receivable. This is
 * allowed regardless of the appointment state because voiding cannot harm a
 * paid customer; it only removes a claim the clinic no longer intends to make.
 */
export async function voidOfflinePayment(input: VoidOfflinePaymentInput): Promise<OfflinePaymentDto> {
  assertDeskActor(input.actor);
  return prisma.$transaction(async (tx) => {
    await lockAppointment(tx, input.appointmentId);

    const payment = await tx.payment.findFirst({
      where: { appointmentId: input.appointmentId, status: $Enums.PaymentStatus.PENDING },
      orderBy: { createdAt: "desc" },
      select: PAYMENT_SELECT,
    });
    if (!payment) {
      throw new AppError(409, "PAYMENT_NOT_PENDING", "This appointment has no pending pay-at-clinic payment to void.");
    }

    const updated = await tx.payment.updateMany({
      where: { id: payment.id, status: $Enums.PaymentStatus.PENDING },
      data: { status: $Enums.PaymentStatus.VOIDED },
    });
    if (updated.count !== 1) {
      throw new AppError(409, "PAYMENT_NOT_PENDING", "The payment changed while this request was in flight.");
    }

    await writeAudit(tx, {
      action: "PAYMENT_VOIDED",
      targetType: "payment",
      targetId: payment.id,
      actor: { id: input.actor.id, role: input.actor.role, name: input.actor.name },
      before: { status: $Enums.PaymentStatus.PENDING, amountPaise: payment.amountPaise },
      after: { status: $Enums.PaymentStatus.VOIDED, appointmentId: input.appointmentId },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return toDto({ ...payment, appointmentId: input.appointmentId, status: $Enums.PaymentStatus.VOIDED });
  });
}

/**
 * The transition/cascade companion: void every still-PENDING receivable for an
 * appointment inside the caller's transaction. Returns how many rows moved.
 * A PAID row is left untouched — it becomes a refund, not a void.
 */
export async function voidPendingPaymentForAppointment(
  client: DbClient,
  input: VoidPendingForAppointmentInput,
): Promise<number> {
  const pending = await client.payment.findMany({
    where: { appointmentId: input.appointmentId, status: $Enums.PaymentStatus.PENDING },
    select: { id: true, amountPaise: true },
  });

  let voided = 0;
  for (const payment of pending) {
    const updated = await client.payment.updateMany({
      where: { id: payment.id, status: $Enums.PaymentStatus.PENDING },
      data: { status: $Enums.PaymentStatus.VOIDED },
    });
    if (updated.count !== 1) continue;
    voided += 1;

    await writeAudit(client, {
      action: "PAYMENT_VOIDED",
      targetType: "payment",
      targetId: payment.id,
      actor: input.actor,
      before: { status: $Enums.PaymentStatus.PENDING, amountPaise: payment.amountPaise },
      after: { status: $Enums.PaymentStatus.VOIDED, appointmentId: input.appointmentId },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  }

  return voided;
}

