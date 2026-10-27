import { $Enums } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/appError.js";
import { logger } from "../../lib/logger.js";
import { isBookable } from "../../lib/doctorState.js";
import { deriveConsultationFee } from "../../lib/fee.js";
import { holdExpiresAt } from "../../lib/slotGuard.js";
import { bookingHorizon } from "../../lib/availability.js";
import { utcToLocalDateTime } from "../../lib/time.js";
import {
  ACTIVE_BOOKING_STATUSES,
  assertNoDuplicateForSlot,
  assertPatientSeatCap,
  assertSlotBookableForBooking,
} from "../../lib/bookingGuard.js";
import { createRazorpayGateway, toGatewayOrderParams } from "../../lib/paymentGateway.js";
import { getClinicSettings } from "../clinic.service.js";
import { writeAudit } from "../audit.service.js";
import type { PaymentOrderDto } from "../../schemas/payments.js";
import type { ActorContext } from "../doctors/doctor.service.js";

/**
 * plan.md §17 / §8.6 — seat hold + Razorpay order, Day 24.
 *
 * Day 23 created the payment row and the gateway order; Day 24 adds what the
 * plan's step 1 actually says: the `SeatHold` and the `PENDING` payment are
 * created **in one transaction**, after §15's guards, BEFORE any money can be
 * asked for. The sequence and why each piece sits where it does:
 *
 *   1. Role re-enforcement (the route already gated PATIENT — double-
 *      enforcement, so a miswired route cannot open this up).
 *   2. Gateway keys checked BEFORE any row: an unconfigured server must not
 *      leave a trail of holds and payment rows it can never pair with an
 *      order.
 *   3. THE HOLD TRANSACTION, and every guard lives inside it, in the order
 *      Day 19's booking transaction proved them:
 *        a. `SELECT … FOR UPDATE` on the patient row — §15's serialization of
 *           one patient's concurrent attempts (also reads email_verified_at,
 *           the §6.3 wall, now under the lock exactly as booking reads it).
 *        b. Slot + doctor load with the §26 generic 404s; §5 bookability
 *           re-applied in-transaction.
 *        c. The non-capacity guards (disabled/started/horizon/unavailability,
 *           §8.5/§10/§11/§12) — the SHARED bookingGuard, not a payment
 *           dialect of it.
 *        d. The same-slot rule (§15): refused HERE, up front, so it is a
 *           clear answer before money rather than a refund after it.
 *        e. Release this patient's OWN unreleased holds first — a live one as
 *           `ABANDONED` (starting a new checkout IS abandoning the old one;
 *           refusing would lock the patient out until expiry for no reason),
 *           an already-expired one as `EXPIRED` (handing back the counter the
 *           sweep would otherwise reclaim later). Each release is guarded and
 *           paired with its `heldCount - 1`, so a concurrent sweep cannot
 *           double-decrement.
 *        f. The §15 cap, counted AFTER the release so the abandoned hold no
 *           longer burns a seat: bookings + live holds ≤
 *           maxActiveBookingsPerPatient.
 *        g. THE CAPACITY CLAIM — `held_count + 1 WHERE booked + held <
 *           max_patients`, raw because Prisma cannot express column-vs-column.
 *           Zero rows is `SLOT_FULL`. The seat is now reserved.
 *        h. The price (shared `deriveConsultationFee`, `ZERO_CONSULTATION_FEE`
 *           guard) and the two rows: `SeatHold` with
 *           `expiresAt = min(now + holdDurationMinutes, slot.startAt)` (§8.6,
 *           via the clinic's own setting) and the `PENDING` `Payment` with no
 *           `appointmentId` and no `orderId` — the order id is the idempotency
 *           key and arrives from the gateway, not from us (§17).
 *   4. THE GATEWAY CALL, OUTSIDE any transaction — an HTTP round trip to a
 *      third party must never hold a database transaction open. Failure takes
 *      §17's `FAILED` path (guarded) AND releases the hold as
 *      `PAYMENT_FAILED` with its `heldCount - 1`: a gateway refusal must not
 *      park a reserved seat for ten minutes.
 *   5. Link `payment.orderId` + `hold.paymentOrderId` + audit in ONE
 *      transaction behind conditional updates — the hold's `paymentOrderId`
 *      is the conversion's lookup key (no FK: a Razorpay order is not a row
 *      here, schema.prisma:668). Either both ids are recorded and attributed,
 *      or nothing changed (409 rather than a silent half-link).
 *
 * Verification, the conversion transaction and the appointment are
 * paymentConvert.service.ts's; refunds of anything that goes wrong after
 * money moves are Day 25's.
 */

export interface CreatePaymentOrderInput {
  readonly actor: ActorContext;
  readonly slotId: string;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

interface HoldTxResult {
  readonly paymentId: string;
  readonly holdId: string;
  readonly amountPaise: number;
  readonly currency: string;
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

  const patientId = input.actor.id;
  const clinic = await getClinicSettings();
  const probe = new Date();
  const horizon = bookingHorizon(utcToLocalDateTime(probe, clinic.timezone).date, clinic.bookingHorizonDays);

  /* 3. THE HOLD TRANSACTION — guards, counters and both rows commit together. */
  const created = await prisma.$transaction(async (tx) => {
    const now = new Date();

    /* (a) Lock the patient row; §6.3's wall is read under the lock. */
    const locked = await tx.$queryRaw<{ email_verified_at: Date | null }[]>`
      SELECT email_verified_at FROM users WHERE id = ${patientId}::uuid FOR UPDATE
    `;
    const patientRow = locked[0];
    if (!patientRow) {
      throw new AppError(404, "PATIENT_NOT_FOUND", "Patient not found");
    }
    if (patientRow.email_verified_at === null) {
      throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before paying online.");
    }

    /* (b) Slot + doctor; §26 generic 404s and §5 bookability, in-transaction. */
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

    /* (c) The shared non-capacity guards (§8.5/§10/§11/§12). */
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

    /* (d) One active booking per patient per slot (§15) — refused BEFORE money. */
    const duplicate = await tx.appointment.findFirst({
      where: { patientId, slotId: slot.id, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
      select: { id: true },
    });
    assertNoDuplicateForSlot(duplicate !== null);

    /* (e) Release this patient's own unreleased holds — the §8.6 one-live-hold
       rule makes at most one relevant, and doing it here (not refusing) is
       what lets a patient change their mind mid-checkout. Guarded + paired
       decrement, so a concurrent sweep holding the same row cannot both win. */
    const ownHolds = await tx.seatHold.findMany({
      where: { patientId, releasedAt: null },
      select: { id: true, slotId: true, expiresAt: true },
    });
    for (const hold of ownHolds) {
      const reason = hold.expiresAt.getTime() > now.getTime()
        ? $Enums.SeatHoldReleaseReason.ABANDONED
        : $Enums.SeatHoldReleaseReason.EXPIRED;
      const released = await tx.seatHold.updateMany({
        where: { id: hold.id, releasedAt: null },
        data: { releasedAt: now, releaseReason: reason },
      });
      if (released.count === 1) {
        await tx.$executeRaw`
          UPDATE slots SET held_count = held_count - 1
          WHERE id = ${hold.slotId}::uuid AND held_count > 0
        `;
      }
    }

    /* (f) §15 cap: active bookings + (still-)live holds, counted after the release. */
    const [activeBookings, activeHolds] = await Promise.all([
      tx.appointment.count({ where: { patientId, status: { in: [...ACTIVE_BOOKING_STATUSES] } } }),
      tx.seatHold.count({ where: { patientId, releasedAt: null, expiresAt: { gt: now } } }),
    ]);
    assertPatientSeatCap(activeBookings + activeHolds, clinic.maxActiveBookingsPerPatient);

    /* (g) THE capacity claim — atomic test-and-increment for a HELD seat (§8.6). */
    const claiming = await tx.$executeRaw`
      UPDATE slots SET held_count = held_count + 1
      WHERE id = ${slot.id}::uuid AND booked_count + held_count < max_patients
    `;
    if (claiming === 0) {
      throw new AppError(409, "SLOT_FULL", "This slot is fully booked.");
    }

    /* (h) The price (§3.4: the client never names one) and the two rows. */
    const amountPaise = deriveConsultationFee(profile.consultationFee, clinic.defaultConsultationFee);
    if (amountPaise <= 0) {
      // The Day 6 CHECK (amount_paise > 0) would refuse it at the database —
      // a raw constraint error is a 500 where this is a business answer.
      throw new AppError(422, "ZERO_CONSULTATION_FEE", "No fee is payable online for this consultation — book at the clinic instead.");
    }
    const currency = clinic.currency;

    const hold = await tx.seatHold.create({
      data: {
        slotId: slot.id,
        patientId,
        expiresAt: holdExpiresAt(now, clinic.holdDurationMinutes * 60_000, slot.startAt),
      },
      select: { id: true },
    });
    const payment = await tx.payment.create({
      data: { patientId, amountPaise, currency },
      select: { id: true },
    });

    return { paymentId: payment.id, holdId: hold.id, amountPaise, currency } satisfies HoldTxResult;
  });

  /* 4. The gateway call, deliberately OUTSIDE any transaction. */
  const gateway = createRazorpayGateway(keyId, keySecret);
  let orderId: string;
  try {
    const order = await gateway.createOrder(
      toGatewayOrderParams({ paymentId: created.paymentId, amountPaise: created.amountPaise, currency: created.currency }),
    );
    orderId = order.orderId;
  } catch (err) {
    logger.error({ err, paymentId: created.paymentId, holdId: created.holdId, slotId: input.slotId }, "gateway order creation failed");

    await prisma.$transaction(async (tx) => {
      const failed = await tx.payment.updateMany({
        where: { id: created.paymentId, status: $Enums.PaymentStatus.PENDING, orderId: null },
        data: { status: $Enums.PaymentStatus.FAILED },
      });
      if (failed.count === 1) {
        // §17: hold released on payment failure — a refused gateway call must
        // not park the seat. Same guarded pair as every other release.
        const released = await tx.seatHold.updateMany({
          where: { id: created.holdId, releasedAt: null },
          data: { releasedAt: new Date(), releaseReason: $Enums.SeatHoldReleaseReason.PAYMENT_FAILED },
        });
        if (released.count === 1) {
          await tx.$executeRaw`
            UPDATE slots SET held_count = held_count - 1
            WHERE id = ${input.slotId}::uuid AND held_count > 0
          `;
        }
        await writeAudit(tx, {
          action: "PAYMENT_ORDER_FAILED",
          targetType: "payment",
          targetId: created.paymentId,
          actor: input.actor,
          after: {
            status: "FAILED",
            amountPaise: created.amountPaise,
            currency: created.currency,
            slotId: input.slotId,
            holdId: created.holdId,
          },
          reason: "Gateway order creation failed",
          ip: input.ip ?? null,
          requestId: input.requestId ?? null,
        });
      }
    });

    throw new AppError(502, "PAYMENT_GATEWAY_ERROR", "We couldn't start the payment. Please try again.");
  }

  /* 5. Link both ids + audit, or change nothing at all. */
  await prisma.$transaction(async (tx) => {
    const linked = await tx.payment.updateMany({
      where: { id: created.paymentId, status: $Enums.PaymentStatus.PENDING, orderId: null },
      data: { orderId },
    });
    if (linked.count !== 1) {
      // The row is no longer the PENDING, unlinked payment this call created.
      // The gateway order behind it simply expires uncaptured (no money moves
      // until conversion), which is the cheap side of the trade.
      throw new AppError(409, "PAYMENT_ORDER_CONFLICT", "This payment is no longer open. Please start again.");
    }

    // The hold's lookup key for conversion (no FK — a gateway order is not a
    // row here). Throwing rolls back the payment link above: both ids or neither.
    const stamped = await tx.seatHold.updateMany({
      where: { id: created.holdId, paymentOrderId: null },
      data: { paymentOrderId: orderId },
    });
    if (stamped.count !== 1) {
      throw new AppError(409, "PAYMENT_ORDER_CONFLICT", "This payment is no longer open. Please start again.");
    }

    await writeAudit(tx, {
      action: "PAYMENT_ORDER_CREATED",
      targetType: "payment",
      targetId: created.paymentId,
      actor: input.actor,
      after: {
        status: "PENDING",
        amountPaise: created.amountPaise,
        currency: created.currency,
        orderId,
        slotId: input.slotId,
        holdId: created.holdId,
      },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });

  return { orderId, keyId, amountPaise: created.amountPaise, currency: created.currency };
}
