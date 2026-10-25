import { $Enums } from "../generated/prisma/client.js";
import { config } from "../config.js";
import { AppError } from "../lib/appError.js";
import { logger } from "../lib/logger.js";
import {
  createRazorpayGateway,
  type GatewayRefund,
  type PaymentGateway,
} from "../lib/paymentGateway.js";
import { prisma, type DbClient } from "../lib/prisma.js";
import { refundNotificationType, remainingRefundablePaise } from "../lib/refundPolicy.js";
import { writeAudit } from "./audit.service.js";
import type { AuditActor } from "./audit.service.js";
import { queueNotification } from "./notification.service.js";

export interface QueueRefundInput {
  readonly paymentId: string;
  readonly kind: $Enums.RefundKind;
  readonly reason: string;
  readonly actor: AuditActor;
  readonly amountPaise?: number | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export interface QueueAppointmentRefundInput {
  readonly appointmentId: string;
  readonly kind: $Enums.RefundKind;
  readonly reason: string;
  readonly actor: AuditActor;
  readonly amountPaise?: number | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export type RefundExecutionOutcome =
  | "success"
  | "failed"
  | "already_success"
  | "failed_retry_deferred"
  | "desk_hand_back_pending"
  | "payment_not_paid"
  | "not_configured"
  | "not_pending";

export interface RefundExecutionResult {
  readonly refundId: string;
  readonly outcome: RefundExecutionOutcome;
}

export interface ExecuteRefundOptions {
  readonly gateway?: PaymentGateway | undefined;
}

interface PaymentLockRow {
  readonly id: string;
  readonly amount_paise: number;
  readonly payment_id: string | null;
}

export async function queueRefund(client: DbClient, input: QueueRefundInput): Promise<string | null> {
  const locked = await client.$queryRaw<PaymentLockRow[]>`
    SELECT id, amount_paise, payment_id FROM payments WHERE id = ${input.paymentId}::uuid FOR UPDATE
  `;
  const payment = locked[0];
  if (!payment) {
    throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment not found");
  }

  const kind = payment.payment_id === null ? $Enums.RefundKind.DESK_HAND_BACK : input.kind;

  const existing = await client.refund.findMany({
    where: { paymentId: payment.id },
    select: { id: true, kind: true, status: true, amountPaise: true },
  });
  const sameKind = existing.find((refund) => refund.kind === kind);
  if (sameKind) {
    return sameKind.status === $Enums.RefundStatus.PENDING ? sameKind.id : null;
  }

  const remaining = remainingRefundablePaise(payment.amount_paise, existing);
  const amountPaise = Math.min(input.amountPaise ?? remaining, remaining);
  if (amountPaise <= 0) return null;

  const refund = await client.refund.create({
    data: {
      paymentId: payment.id,
      kind,
      amountPaise,
      status: $Enums.RefundStatus.PENDING,
      reason: input.reason,
      actorId: input.actor.id ?? null,
      actorRole: input.actor.role ?? null,
      actorName: input.actor.name,
    },
  });

  await writeAudit(client, {
    action: "REFUND_QUEUED",
    targetType: "refund",
    targetId: refund.id,
    actor: input.actor,
    after: {
      paymentId: payment.id,
      kind,
      amountPaise,
      status: $Enums.RefundStatus.PENDING,
      requestedKind: input.kind,
    },
    reason: input.reason,
    ip: input.ip ?? null,
    requestId: input.requestId ?? null,
  });

  return refund.id;
}

export async function queueRefundForAppointment(
  client: DbClient,
  input: QueueAppointmentRefundInput,
): Promise<string | null> {
  const payment = await client.payment.findFirst({
    where: { appointmentId: input.appointmentId, status: $Enums.PaymentStatus.PAID },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!payment) return null;

  return queueRefund(client, {
    paymentId: payment.id,
    kind: input.kind,
    reason: input.reason,
    actor: input.actor,
    amountPaise: input.amountPaise,
    ip: input.ip,
    requestId: input.requestId,
  });
}

const inFlight = new Map<string, Promise<RefundExecutionResult>>();

export function executeRefund(
  refundId: string,
  options: ExecuteRefundOptions = {},
): Promise<RefundExecutionResult> {
  const current = inFlight.get(refundId);
  if (current) return current;

  const run = executeRefundOnce(refundId, options).finally(() => {
    inFlight.delete(refundId);
  });
  inFlight.set(refundId, run);
  return run;
}

async function executeRefundOnce(
  refundId: string,
  options: ExecuteRefundOptions,
): Promise<RefundExecutionResult> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: {
      id: true,
      status: true,
      kind: true,
      amountPaise: true,
      payment: {
        select: {
          id: true,
          status: true,
          paymentId: true,
          currency: true,
          orderId: true,
          appointmentId: true,
          patient: { select: { email: true } },
          appointment: { select: { slotId: true } },
        },
      },
    },
  });

  if (!refund) {
    throw new AppError(404, "REFUND_NOT_FOUND", "Refund not found");
  }
  if (refund.status === $Enums.RefundStatus.SUCCESS) {
    return { refundId: refund.id, outcome: "already_success" };
  }
  if (refund.status === $Enums.RefundStatus.FAILED) {
    return { refundId: refund.id, outcome: "failed_retry_deferred" };
  }
  if (refund.payment.status !== $Enums.PaymentStatus.PAID) {
    return { refundId: refund.id, outcome: "payment_not_paid" };
  }
  if (refund.payment.paymentId === null) {
    return { refundId: refund.id, outcome: "desk_hand_back_pending" };
  }

  const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } = config;
  if (options.gateway === undefined && (keyId === undefined || keySecret === undefined)) {
    logger.warn({ refundId: refund.id }, "refund left pending: Razorpay is not configured");
    return { refundId: refund.id, outcome: "not_configured" };
  }

  const gateway = options.gateway ?? createRazorpayGateway(keyId as string, keySecret as string);

  let result: GatewayRefund;
  try {
    result = await gateway.refundPayment({
      paymentId: refund.payment.paymentId,
      amountPaise: refund.amountPaise,
      currency: refund.payment.currency,
      refundId: refund.id,
    });
  } catch (err) {
    logger.error({ err, refundId: refund.id }, "gateway refund failed");

    await prisma.$transaction(async (tx) => {
      const updated = await tx.refund.updateMany({
        where: { id: refund.id, status: $Enums.RefundStatus.PENDING },
        data: { status: $Enums.RefundStatus.FAILED },
      });
      if (updated.count !== 1) return;

      await writeAudit(tx, {
        action: "REFUND_FAILED",
        targetType: "refund",
        targetId: refund.id,
        actor: { name: "system" },
        before: { status: $Enums.RefundStatus.PENDING },
        after: { status: $Enums.RefundStatus.FAILED },
        reason: err instanceof Error ? err.message : "Gateway refund failed",
      });
    });

    return { refundId: refund.id, outcome: "failed" };
  }

  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.refund.updateMany({
      where: { id: refund.id, status: $Enums.RefundStatus.PENDING },
      data: {
        status: $Enums.RefundStatus.SUCCESS,
        gatewayRefundId: result.refundId,
      },
    });
    if (updated.count !== 1) return false;

    let slotId = refund.payment.appointment?.slotId ?? null;
    if (slotId === null && refund.payment.orderId !== null) {
      const hold = await tx.seatHold.findFirst({
        where: { paymentOrderId: refund.payment.orderId },
        select: { slotId: true },
      });
      slotId = hold?.slotId ?? null;
    }

    if (refund.payment.patient.email !== null) {
      await queueNotification(tx, {
        type: refundNotificationType(refund.kind),
        recipient: refund.payment.patient.email,
        appointmentId: refund.payment.appointmentId,
        slotId,
      });
    }

    await writeAudit(tx, {
      action: "REFUND_SUCCEEDED",
      targetType: "refund",
      targetId: refund.id,
      actor: { name: "system" },
      before: { status: $Enums.RefundStatus.PENDING },
      after: {
        status: $Enums.RefundStatus.SUCCESS,
        paymentId: refund.payment.id,
        amountPaise: refund.amountPaise,
        gatewayRefundId: result.refundId,
      },
    });

    return true;
  });

  return {
    refundId: refund.id,
    outcome: applied ? "success" : "not_pending",
  };
}

export async function executePendingRefunds(
  options: ExecuteRefundOptions & { readonly limit?: number | undefined } = {},
): Promise<readonly RefundExecutionResult[]> {
  const pending = await prisma.refund.findMany({
    where: { status: $Enums.RefundStatus.PENDING },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 50,
    select: { id: true },
  });

  const results: RefundExecutionResult[] = [];
  for (const refund of pending) {
    try {
      results.push(await executeRefund(refund.id, options));
    } catch (err) {
      logger.error({ err, refundId: refund.id }, "pending refund execution failed");
    }
  }
  return results;
}

export function kickRefundWorker(limit = 25): void {
  setImmediate(() => {
    void executePendingRefunds({ limit }).catch((err: unknown) => {
      logger.error({ err }, "refund worker sweep failed");
    });
  });
}
