import { $Enums } from "../generated/prisma/client.js";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { logger } from "../lib/logger.js";
import { isBookable } from "../lib/doctorState.js";
import { deriveConsultationFee } from "../lib/fee.js";
import { createRazorpayGateway, toGatewayOrderParams } from "../lib/paymentGateway.js";
import { ensureEmailVerified } from "./auth.service.js";
import { getClinicSettings } from "./clinic.service.js";
import { writeAudit } from "./audit.service.js";
import type { PaymentOrderDto } from "../schemas/payments.js";
import type { ActorContext } from "./doctor.service.js";

/**
 * plan.md §17 / §8.6 — create a Razorpay order, Day 23 (order + checkout only).
 *
 * Day 23 is deliberately the FIRST HALF of §17's step 1: a `PENDING` payment
 * and a real gateway order, no `SeatHold`, no capacity claim, no appointment.
 * The seat-holding transaction — hold + cap checks + same-slot rule, then this
 * same order flow folded into it — is Day 24, and folding it in later is safe
 * precisely because this service never claims a seat it would have to give back.
 *
 * The sequence, and why each step sits where it does:
 *
 *   1. Role re-enforcement (the route already gated PATIENT — Day 12's
 *      double-enforcement, so a miswired route cannot open this up).
 *   2. Gateway keys checked BEFORE any row: an unconfigured server must not
 *      leave a trail of payment rows it can never pair with an order.
 *   3. §6.3's email-verified wall, same gate as booking — an order for an
 *      account that cannot yet book is money chasing a booking Day 24 would
 *      refuse (and auto-refund, §17 step 6).
 *   4. Slot + doctor load with the §26 generic 404s, then the ONE price:
 *      `deriveConsultationFee`, the same function Day 19's transaction writes
 *      into `feeAmount` (lib/fee.ts). The §8.5/§10/§12/cap/same-slot guards
 *      are NOT re-implemented here — they belong to Day 24's hold transaction,
 *      which is the authoritative in-transaction re-check for anything that
 *      can actually consume a seat.
 *   5. The row: a single INSERT, its own atomic statement, `PENDING` with no
 *      `orderId` yet (§17: the order id is the idempotency key and arrives
 *      from the gateway, not from us).
 *   6. THE GATEWAY CALL, OUTSIDE any transaction — an HTTP round trip to a
 *      third party must never hold a database transaction open; a slow
 *      gateway would otherwise pin connections for as long as it likes.
 *   7. Link `orderId` + audit in ONE small transaction behind a conditional
 *      update (`status = PENDING AND order_id IS NULL`): either the order is
 *      recorded and attributed, or nothing changed. A count of 0 means the row
 *      moved under us (nothing on Day 23 can move it; Day 24's void paths can),
 *      which is a 409 rather than a silent overwrite.
 *
 * Gateway failure takes the §17 status literally — `FAILED` is defined as "a
 * gateway call that never returned an order" — so the row is marked FAILED
 * with its own audit row before the patient is told 502.
 *
 * Verification, webhooks and conversion are Day 24; refunds of anything that
 * goes wrong after money moves are Day 25. Until then a successful checkout on
 * this endpoint is an accepted dead-end (DoD: "an order is created and the
 * checkout opens").
 */

export interface CreatePaymentOrderInput {
  readonly actor: ActorContext;
  readonly slotId: string;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export async function createPaymentOrder(input: CreatePaymentOrderInput): Promise<PaymentOrderDto> {
  // Day 19's double-enforcement: the route gates PATIENT, the service says so again.
  if (input.actor.role !== $Enums.UserRole.PATIENT) {
    throw new AppError(403, "FORBIDDEN", "Only a patient can start an online payment");
  }

  const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } = config;
  if (keyId === undefined || keySecret === undefined) {
    // Fail fast, before any row: RAZORPAY_* are optional until Phase 6
    // (.env.example), so "unset" is a normal local state with a normal answer.
    throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Online payments are not configured yet. Please pay at the clinic.");
  }

  await ensureEmailVerified(input.actor.id);

  const clinic = await getClinicSettings();
  const slot = await prisma.slot.findUnique({
    where: { id: input.slotId },
    select: {
      id: true,
      doctorId: true,
      doctor: {
        select: {
          role: true,
          fullName: true,
          doctorProfile: { select: { verificationStatus: true, suspendedAt: true, consultationFee: true } },
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
    // The same §26 generic miss booking uses: a hidden doctor reveals nothing.
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }

  const amountPaise = deriveConsultationFee(profile.consultationFee, clinic.defaultConsultationFee);
  if (amountPaise <= 0) {
    // `deriveConsultationFee` faithfully passes a zero through — but the Day 6
    // `CHECK (amount_paise > 0)` on payments would refuse it at the database,
    // and a raw constraint error is a 500 where this is a business answer.
    throw new AppError(422, "ZERO_CONSULTATION_FEE", "No fee is payable online for this consultation — book at the clinic instead.");
  }
  const currency = clinic.currency;

  /* 5. The row — one INSERT, atomic on its own, no transaction needed yet. */
  const payment = await prisma.payment.create({
    data: { patientId: input.actor.id, amountPaise, currency },
    select: { id: true },
  });

  /* 6. The gateway call, deliberately OUTSIDE any transaction (see above). */
  const gateway = createRazorpayGateway(keyId, keySecret);
  let orderId: string;
  try {
    const order = await gateway.createOrder(
      toGatewayOrderParams({ paymentId: payment.id, amountPaise, currency }),
    );
    orderId = order.orderId;
  } catch (err) {
    logger.error({ err, paymentId: payment.id, slotId: slot.id }, "gateway order creation failed");

    await prisma.$transaction(async (tx) => {
      const failed = await tx.payment.updateMany({
        where: { id: payment.id, status: $Enums.PaymentStatus.PENDING, orderId: null },
        data: { status: $Enums.PaymentStatus.FAILED },
      });
      if (failed.count === 1) {
        await writeAudit(tx, {
          action: "PAYMENT_ORDER_FAILED",
          targetType: "payment",
          targetId: payment.id,
          actor: input.actor,
          after: { status: "FAILED", amountPaise, currency, slotId: slot.id },
          reason: "Gateway order creation failed",
          ip: input.ip ?? null,
          requestId: input.requestId ?? null,
        });
      }
    });

    throw new AppError(502, "PAYMENT_GATEWAY_ERROR", "We couldn't start the payment. Please try again.");
  }

  /* 7. Link the order id and audit it, or change nothing at all. */
  await prisma.$transaction(async (tx) => {
    const linked = await tx.payment.updateMany({
      where: { id: payment.id, status: $Enums.PaymentStatus.PENDING, orderId: null },
      data: { orderId },
    });
    if (linked.count !== 1) {
      // The row is no longer the PENDING, unlinked payment this call created.
      // The gateway order behind it simply expires uncaptured (no money moves
      // until Day 24's conversion), which is the cheap side of the trade.
      throw new AppError(409, "PAYMENT_ORDER_CONFLICT", "This payment is no longer open. Please start again.");
    }

    await writeAudit(tx, {
      action: "PAYMENT_ORDER_CREATED",
      targetType: "payment",
      targetId: payment.id,
      actor: input.actor,
      after: { status: "PENDING", amountPaise, currency, orderId, slotId: slot.id, doctorId: slot.doctorId },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });

  return { orderId, keyId, amountPaise, currency };
}
