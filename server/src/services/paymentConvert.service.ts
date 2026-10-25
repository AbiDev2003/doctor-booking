import { $Enums } from "../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { logger } from "../lib/logger.js";
import { isBookable } from "../lib/doctorState.js";
import { ACTIVE_BOOKING_STATUSES, assertNoDuplicateForSlot } from "../lib/bookingGuard.js";
import {
  conversionFailureRefundKind,
  conversionFailureReleaseReason,
} from "../lib/refundPolicy.js";
import { writeAudit } from "./audit.service.js";
import { queueRefund } from "./refund.service.js";
import type { AuditActor } from "./audit.service.js";
import type { AppointmentDto } from "../schemas/appointments.js";
import type { DbClient } from "../lib/prisma.js";

/**
 * plan.md §17 steps 3–5 / §8.6 — THE conversion, Day 24.
 *
 * One function is the whole success path, and both callers converge on it:
 * the browser's `POST /payments/verify` (signature checked at the route) and
 * Razorpay's webhook (raw-body signature checked at the route). The core
 * re-checks nothing about SIGNATURES — that is the edges' job — and owns
 * exactly what the plan's step 5 puts in one transaction:
 *
 *   1. `SELECT … FOR UPDATE` on the payment row keyed by `order_id` (the §17
 *      idempotency key). The lock is the idempotency mechanism: a concurrent
 *      verify + webhook serialize HERE, the loser reads `PAID` and returns the
 *      stored appointment with zero writes (§17: "retried webhooks, client
 *      retries, double-clicks ... converge to one processed event").
 *   2. Pre-tx refusals book NOTHING: unknown order (404, no oracle), another
 *      patient's payment (404), a non-`PENDING` payment (409), a released hold
 *      (409) or an expired hold (409) — §17's step 4. On Day 25 a signed
 *      payment behind such a refusal is settled OUTSIDE the rolled-back tx:
 *      `PAID`, hold released, seat handed back, full refund queued.
 *   3. Re-checks against live rows INSIDE the transaction: doctor still
 *      bookable, slot not disabled, no active same-slot booking (§15) — a
 *      hold was valid when taken, and ten minutes is long enough for any of
 *      these to have changed underneath it.
 *   4. THE seat move (§17's literal statement): `held_count - 1,
 *      booked_count + 1 WHERE held_count > 0`. Zero rows → the hold is not
 *      backed by a reserved seat → rollback, nothing exists.
 *   5. The `Appointment` is CREATED `CONFIRMED` (never `PENDING` — §13/§8.6:
 *      an appointment may only come into existence at the moment the seat is
 *      genuinely consumed), its BOOKED history event, then the hold
 *      `CONVERTED` (guarded), the payment `PAID` (guarded, stamped with the
 *      gateway payment id + `paidAt`), and the audit rows — all of it commits
 *      together or not at all.
 *
 * `feeAmount` is the PAID amount (`payments.amount_paise`), not a fresh fee
 * derivation: by the time money has moved, the agreement is the number on the
 * money row — re-deriving would let a fee edit between hold and payment
 * rewrite what the patient actually paid.
 *
 * Rejections roll the transaction back, then `settleFailedConversion` records
 * the captured money as `PAID` + a full `Refund` and releases the hold. The
 * settlement runs in a second transaction because the first one is already
 * aborted; the caller still receives the original refusal. `PAYMENT_NOT_FOUND`
 * (including another patient's order) and signature failures never settle —
 * there is no proven captured payment to return.
 */

export interface ConvertPaymentInput {
  readonly orderId: string;
  /** The gateway's payment id (`pay_…`) — stored on the row for reconciliation (§17). */
  readonly gatewayPaymentId: string;
  /** The verify route passes the signed-in patient; a mismatch is a 404, never a "not yours" 403. The webhook has no user and passes nothing. */
  readonly expectedPatientId?: string | null | undefined;
  /** Patient actor (verify) or `{ name: "system" }` (webhook) — §20's nullable id/role. */
  readonly actor: AuditActor;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

interface PaymentLockRow {
  readonly id: string;
  readonly patient_id: string;
  readonly status: string;
  readonly appointment_id: string | null;
  readonly amount_paise: number;
  readonly currency: string;
}

interface LoadedAppointment {
  readonly id: string;
  readonly doctorId: string;
  readonly doctorName: string;
  readonly patientId: string;
  readonly slotId: string;
  readonly status: $Enums.AppointmentStatus;
  readonly feeAmount: number;
  readonly bookingTime: Date;
  readonly createdAt: Date;
  readonly slot: { readonly slotDate: Date; readonly startTime: Date; readonly endTime: Date };
}

/** The DTO both paths return — identical to booking's (Day 19), one client renderer. */
async function appointmentDto(client: DbClient, appointmentId: string): Promise<AppointmentDto> {
  const row = await client.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      doctorId: true,
      doctorName: true,
      patientId: true,
      slotId: true,
      status: true,
      feeAmount: true,
      bookingTime: true,
      createdAt: true,
      slot: { select: { slotDate: true, startTime: true, endTime: true } },
    },
  });
  if (!row) {
    // Reached only if a PAID payment lost its appointment — impossible on this
    // day's paths (both are written in one transaction), hence a 500 and not
    // a client-answerable code.
    throw new AppError(500, "CONVERSION_STATE_INVALID", "Payment is recorded as paid but its booking is missing");
  }
  return toDto(row);
}

function toDto(row: LoadedAppointment): AppointmentDto {
  return {
    id: row.id,
    doctorId: row.doctorId,
    doctorName: row.doctorName,
    patientId: row.patientId,
    slotId: row.slotId,
    slotDate: row.slot.slotDate.toISOString().slice(0, 10),
    startTime: hhmm(row.slot.startTime),
    endTime: hhmm(row.slot.endTime),
    status: row.status,
    feeAmount: row.feeAmount,
    bookingTime: row.bookingTime.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` a client renders. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

interface FailurePaymentRow {
  readonly id: string;
  readonly patient_id: string;
  readonly status: $Enums.PaymentStatus;
  readonly appointment_id: string | null;
  readonly payment_id: string | null;
}

async function settleFailedConversion(input: ConvertPaymentInput, error: AppError): Promise<void> {
  const kind = conversionFailureRefundKind(error.code);
  if (kind === null) return;

  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<FailurePaymentRow[]>`
      SELECT id, patient_id, status, appointment_id, payment_id
      FROM payments WHERE order_id = ${input.orderId} FOR UPDATE
    `;
    const payment = locked[0];
    if (!payment) return;
    if (
      input.expectedPatientId !== undefined &&
      input.expectedPatientId !== null &&
      payment.patient_id !== input.expectedPatientId
    ) {
      return;
    }
    if (payment.appointment_id !== null) return;

    const now = new Date();
    if (payment.status !== $Enums.PaymentStatus.PAID) {
      await tx.payment.updateMany({
        where: { id: payment.id },
        data: {
          status: $Enums.PaymentStatus.PAID,
          paymentId: payment.payment_id ?? input.gatewayPaymentId,
          paidAt: now,
        },
      });
    } else if (payment.payment_id === null) {
      await tx.payment.updateMany({
        where: { id: payment.id },
        data: { paymentId: input.gatewayPaymentId },
      });
    }

    const hold = await tx.seatHold.findFirst({
      where: { paymentOrderId: input.orderId },
      select: { id: true, slotId: true, releasedAt: true },
    });

    let holdReleased = false;
    if (hold && hold.releasedAt === null) {
      const released = await tx.seatHold.updateMany({
        where: { id: hold.id, releasedAt: null },
        data: {
          releasedAt: now,
          releaseReason: conversionFailureReleaseReason(kind),
        },
      });
      if (released.count === 1) {
        holdReleased = true;
        await tx.$executeRaw`
          UPDATE slots SET held_count = held_count - 1
          WHERE id = ${hold.slotId}::uuid AND held_count > 0
        `;
      }
    }

    const refundId = await queueRefund(tx, {
      paymentId: payment.id,
      kind,
      reason:
        kind === $Enums.RefundKind.EXPIRED_HOLD
          ? "Payment captured after the seat hold expired (§8.6)"
          : error.message,
      actor: input.actor,
      ip: input.ip,
      requestId: input.requestId,
    });

    await writeAudit(tx, {
      action: "PAYMENT_CONVERSION_FAILED",
      targetType: "payment",
      targetId: payment.id,
      actor: input.actor,
      before: {
        status: payment.status,
        paymentId: payment.payment_id,
      },
      after: {
        status: $Enums.PaymentStatus.PAID,
        paymentId: payment.payment_id ?? input.gatewayPaymentId,
        orderId: input.orderId,
        failureCode: error.code,
        refundKind: kind,
        refundId,
        holdReleased,
      },
      reason: error.message,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

export async function convertPayment(input: ConvertPaymentInput): Promise<AppointmentDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();

      /* 1. The payment row, locked — idempotency by serialization. */
      const locked = await tx.$queryRaw<PaymentLockRow[]>`
        SELECT id, patient_id, status, appointment_id, amount_paise, currency
        FROM payments WHERE order_id = ${input.orderId} FOR UPDATE
      `;
      const payment = locked[0];
      if (!payment || (input.expectedPatientId !== undefined && input.expectedPatientId !== null && payment.patient_id !== input.expectedPatientId)) {
        // Same 404 either way: an order id that is not yours must be
        // indistinguishable from an order id that does not exist (§26).
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment not found");
      }

      if (payment.status === $Enums.PaymentStatus.PAID) {
        // The replay/convergent path: the other caller won, return its result.
        if (payment.appointment_id === null) {
          throw new AppError(500, "CONVERSION_STATE_INVALID", "Payment is recorded as paid but its booking is missing");
        }
        return appointmentDto(tx, payment.appointment_id);
      }
      if (payment.status !== $Enums.PaymentStatus.PENDING) {
        // FAILED/VOIDED: the money did not move (or was already settled) —
        // nothing to convert, and a retry cannot change the row.
        throw new AppError(409, "PAYMENT_NOT_PENDING", "This payment is not open for conversion.");
      }

      /* 2. Pre-tx refusals (§17 step 4): hold present, unreleased, unexpired. */
      const hold = await tx.seatHold.findFirst({
        where: { paymentOrderId: input.orderId },
        select: { id: true, slotId: true, releasedAt: true, expiresAt: true, appointmentId: true },
      });
      if (!hold) {
        throw new AppError(409, "HOLD_NOT_FOUND", "The reserved seat for this payment is missing.");
      }
      if (hold.releasedAt !== null) {
        throw new AppError(409, "HOLD_RELEASED", "The reserved seat for this payment was released.");
      }
      if (hold.expiresAt.getTime() <= now.getTime()) {
        // §8.6/§17: the seat is not booked; the catch below settles the
        // captured money as PAID + a full EXPIRED_HOLD refund.
        throw new AppError(409, "HOLD_EXPIRED", "The reservation expired before payment completed. You will not be charged for this booking.");
      }

      /* 3. Live-row re-checks inside the transaction. */
      const slot = await tx.slot.findUnique({
        where: { id: hold.slotId },
        select: {
          id: true,
          doctorId: true,
          isDisabled: true,
          endAt: true,
          doctor: {
            select: {
              fullName: true,
              role: true,
              doctorProfile: { select: { verificationStatus: true, suspendedAt: true } },
            },
          },
        },
      });
      if (!slot) {
        // FK-protected (Restrict) — unreachable unless the database is broken.
        throw new AppError(409, "CONVERSION_FAILED", "The reserved slot no longer exists.");
      }
      const profile = slot.doctor.doctorProfile;
      if (slot.isDisabled) {
        throw new AppError(409, "SLOT_DISABLED", "This slot is no longer available.");
      }
      if (
        slot.doctor.role !== $Enums.UserRole.DOCTOR ||
        profile === null ||
        !isBookable({ verificationStatus: profile.verificationStatus, suspendedAt: profile.suspendedAt })
      ) {
        throw new AppError(409, "DOCTOR_UNAVAILABLE", "The doctor is unavailable for this slot.");
      }
      const duplicate = await tx.appointment.findFirst({
        where: { patientId: payment.patient_id, slotId: slot.id, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        select: { id: true },
      });
      assertNoDuplicateForSlot(duplicate !== null);

      /* 4. THE seat move — §17's literal statement; zero rows is a rollback. */
      const moved = await tx.$executeRaw`
        UPDATE slots SET held_count = held_count - 1, booked_count = booked_count + 1
        WHERE id = ${slot.id}::uuid AND held_count > 0
      `;
      if (moved === 0) {
        throw new AppError(409, "CONVERSION_FAILED", "The reserved seat could not be claimed.");
      }

      /* 5a. The appointment, born CONFIRMED, snapshotted from the PAID amount. */
      const created = await tx.appointment.create({
        data: {
          doctorId: slot.doctorId,
          patientId: payment.patient_id,
          slotId: slot.id,
          status: $Enums.AppointmentStatus.CONFIRMED,
          doctorName: slot.doctor.fullName,
          feeAmount: payment.amount_paise,
          bookingTime: now,
        },
        select: {
          id: true,
          doctorId: true,
          doctorName: true,
          patientId: true,
          slotId: true,
          status: true,
          feeAmount: true,
          bookingTime: true,
          createdAt: true,
          slot: { select: { slotDate: true, startTime: true, endTime: true } },
        },
      });

      /* 5b. Hold → CONVERTED, guarded: only an unreleased hold may convert. */
      const converted = await tx.seatHold.updateMany({
        where: { id: hold.id, releasedAt: null },
        data: {
          releasedAt: now,
          releaseReason: $Enums.SeatHoldReleaseReason.CONVERTED,
          appointmentId: created.id,
        },
      });
      if (converted.count !== 1) {
        throw new AppError(409, "CONVERSION_FAILED", "The reserved seat could not be claimed.");
      }

      /* 5c. Payment → PAID, guarded — the lock makes this single-winner anyway;
         the guard keeps the statement honest if a future path bypasses the lock. */
      const paid = await tx.payment.updateMany({
        where: { id: payment.id, status: $Enums.PaymentStatus.PENDING },
        data: {
          status: $Enums.PaymentStatus.PAID,
          paymentId: input.gatewayPaymentId,
          appointmentId: created.id,
          paidAt: now,
        },
      });
      if (paid.count !== 1) {
        throw new AppError(409, "CONVERSION_FAILED", "The payment could not be marked as paid.");
      }

      /* 5d. History + audit, in the transaction with everything they describe. */
      await tx.appointmentHistory.create({
        data: {
          appointmentId: created.id,
          eventType: $Enums.AppointmentEventType.BOOKED,
          fromStatus: null,
          toStatus: $Enums.AppointmentStatus.CONFIRMED,
          actorId: input.actor.id ?? null,
          actorRole: input.actor.role ?? null,
          actorName: input.actor.name,
          ip: input.ip ?? null,
          requestId: input.requestId ?? null,
          metadata: { slotId: slot.id, doctorId: slot.doctorId, source: "online_payment", orderId: input.orderId },
        },
      });

      await writeAudit(tx, {
        action: "APPOINTMENT_BOOKED",
        targetType: "appointment",
        targetId: created.id,
        actor: input.actor,
        after: {
          status: $Enums.AppointmentStatus.CONFIRMED,
          doctorId: slot.doctorId,
          patientId: payment.patient_id,
          slotId: slot.id,
          feeAmount: payment.amount_paise,
          source: "online_payment",
        },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      await writeAudit(tx, {
        action: "PAYMENT_PAID",
        targetType: "payment",
        targetId: payment.id,
        actor: input.actor,
        after: {
          status: $Enums.PaymentStatus.PAID,
          amountPaise: payment.amount_paise,
          currency: payment.currency,
          orderId: input.orderId,
          gatewayPaymentId: input.gatewayPaymentId,
          appointmentId: created.id,
        },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return toDto(created);
    });
  } catch (err) {
    // The same-slot partial unique index (§15) is the guarantee; the explicit
    // check above is the clean path. A race that slips past it maps to the
    // 409 a client already knows (and rolls everything back — money untouched).
    const failure =
      isUniqueConstraintViolation(err)
        ? new AppError(409, "ALREADY_BOOKED", "You already have a booking for this slot.")
        : err;

    if (failure instanceof AppError) {
      try {
        await settleFailedConversion(input, failure);
      } catch (settlementError) {
        logger.error({ err: settlementError, orderId: input.orderId }, "failed to settle captured payment");
      }
    }
    throw failure;
  }
}
