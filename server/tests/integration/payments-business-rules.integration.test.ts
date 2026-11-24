import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { $Enums } from "../../src/generated/prisma/client.js";
import { AppError } from "../../src/lib/appError.js";
import type { PaymentGateway } from "../../src/lib/paymentGateway.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  conversionFailureRefundKind,
  conversionFailureReleaseReason,
  refundNotificationType,
} from "../../src/lib/refundPolicy.js";
import { rescheduleAppointment } from "../../src/services/appointments/reschedule.service.js";
import type { ActorContext } from "../../src/services/doctors/doctor.service.js";
import {
  convertPayment,
  type ConvertPaymentInput,
} from "../../src/services/payments/paymentConvert.service.js";
import { executeRefund } from "../../src/services/payments/refund.service.js";
import {
  createClinic,
  createDoctor,
  createLoginPatient,
  createSlot,
} from "./factories.js";

vi.mock("../../src/services/notifications/notification.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/notifications/notification.service.js")>();
  return { ...actual, dispatchNotificationInBackground: vi.fn() };
});

const FEE = 50_000;

function dateAfter(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const refundGateway: PaymentGateway = {
  async createOrder() {
    throw new Error("createOrder is not used by these integration tests");
  },
  async refundPayment(params) {
    return {
      refundId: `rf_day37_${params.refundId}`,
      amountPaise: params.amountPaise,
      status: "refunded",
    };
  },
};

function actorFor(user: {
  readonly id: string;
  readonly role: $Enums.UserRole;
  readonly fullName: string;
}): ActorContext {
  return { id: user.id, role: user.role, name: user.fullName };
}

async function setClinicFee(amountPaise: number): Promise<void> {
  await prisma.clinic.updateMany({ data: { defaultConsultationFee: amountPaise } });
}

async function createPendingOrder(patientId: string, slotId: string) {
  const orderId = `order_day37_${randomUUID()}`;
  const payment = await prisma.payment.create({
    data: {
      patientId,
      orderId,
      amountPaise: FEE,
      currency: "INR",
      status: $Enums.PaymentStatus.PENDING,
    },
  });
  const hold = await prisma.seatHold.create({
    data: {
      slotId,
      patientId,
      paymentOrderId: orderId,
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  await prisma.slot.update({ where: { id: slotId }, data: { heldCount: 1 } });
  return { orderId, payment, hold };
}

async function expectConversionFailure(input: ConvertPaymentInput, code: string): Promise<void> {
  try {
    await convertPayment(input);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Expected convertPayment to fail with ${code}, but it succeeded.`);
}

interface FailureCase {
  readonly code: string;
  readonly deleteHold?: boolean;
  readonly releaseHold?: boolean;
  readonly expireHold?: boolean;
  readonly disableSlot?: boolean;
  readonly suspendDoctor?: boolean;
  readonly prebookSameSlot?: boolean;
  readonly staleHeldCount?: boolean;
}

async function assertFailureCase(testCase: FailureCase): Promise<void> {
  const doctor = await createDoctor();
  const patient = await createLoginPatient();
  const slot = await createSlot(doctor.id);
  const order = await createPendingOrder(patient.user.id, slot.id);
  const gatewayPaymentId = `pay_day37_${randomUUID()}`;

  if (testCase.deleteHold === true) {
    await prisma.seatHold.delete({ where: { id: order.hold.id } });
    await prisma.slot.update({ where: { id: slot.id }, data: { heldCount: 0 } });
  }
  if (testCase.releaseHold === true) {
    await prisma.seatHold.update({
      where: { id: order.hold.id },
      data: {
        releasedAt: new Date(),
        releaseReason: $Enums.SeatHoldReleaseReason.ABANDONED,
      },
    });
    await prisma.slot.update({ where: { id: slot.id }, data: { heldCount: 0 } });
  }
  if (testCase.expireHold === true) {
    await prisma.seatHold.update({
      where: { id: order.hold.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
  }
  if (testCase.disableSlot === true) {
    await prisma.slot.update({ where: { id: slot.id }, data: { isDisabled: true } });
  }
  if (testCase.suspendDoctor === true) {
    await prisma.doctorProfile.update({
      where: { userId: doctor.id },
      data: { suspendedAt: new Date() },
    });
  }
  if (testCase.staleHeldCount === true) {
    await prisma.slot.update({ where: { id: slot.id }, data: { heldCount: 0 } });
  }
  if (testCase.prebookSameSlot === true) {
    await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patient.user.id,
        slotId: slot.id,
        status: $Enums.AppointmentStatus.CONFIRMED,
        doctorName: doctor.fullName,
        feeAmount: FEE,
        bookingTime: new Date(),
      },
    });
  }

  const appointmentsBefore = await prisma.appointment.count({ where: { patientId: patient.user.id } });
  const actor = actorFor(patient.user);

  await expectConversionFailure(
    {
      orderId: order.orderId,
      gatewayPaymentId,
      expectedPatientId: patient.user.id,
      actor,
      requestId: `day37-${testCase.code}`,
    },
    testCase.code,
  );

  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: order.payment.id } });
  expect(payment.status).toBe($Enums.PaymentStatus.PAID);
  expect(payment.paymentId).toBe(gatewayPaymentId);
  expect(payment.appointmentId).toBeNull();
  expect(payment.paidAt).not.toBeNull();
  expect(await prisma.appointment.count({ where: { patientId: patient.user.id } })).toBe(appointmentsBefore);

  const expectedKind = conversionFailureRefundKind(testCase.code);
  if (expectedKind === null) {
    throw new Error(`No refund mapping for ${testCase.code}`);
  }
  const refund = await prisma.refund.findUniqueOrThrow({
    where: { paymentId_kind: { paymentId: payment.id, kind: expectedKind } },
  });
  expect(refund.amountPaise).toBe(FEE);

  if (testCase.releaseHold === true) {
    const released = await prisma.seatHold.findUniqueOrThrow({ where: { id: order.hold.id } });
    expect(released.releaseReason).toBe($Enums.SeatHoldReleaseReason.ABANDONED);
  } else if (testCase.deleteHold !== true) {
    const hold = await prisma.seatHold.findUniqueOrThrow({ where: { id: order.hold.id } });
    expect(hold.releasedAt).not.toBeNull();
    expect(hold.releaseReason).toBe(conversionFailureReleaseReason(expectedKind));
  }

  const slotAfter = await prisma.slot.findUniqueOrThrow({ where: { id: slot.id }, select: { heldCount: true } });
  expect(slotAfter.heldCount).toBe(0);

  const executed = await executeRefund(refund.id, { gateway: refundGateway });
  expect(executed.outcome).toBe("success");
  const refundAfter = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  expect(refundAfter.status).toBe($Enums.RefundStatus.SUCCESS);
  expect(refundAfter.gatewayRefundId).not.toBeNull();
  expect(
    await prisma.notification.count({
      where: { recipient: patient.user.email ?? "", type: refundNotificationType(expectedKind) },
    }),
  ).toBe(1);
  expect(
    await prisma.auditLog.count({ where: { action: "PAYMENT_CONVERSION_FAILED", targetId: payment.id } }),
  ).toBe(1);
}

async function createRescheduleFixture(
  appointmentFeeAmount: number,
  paymentStatus: $Enums.PaymentStatus | null,
) {
  const doctor = await createDoctor();
  const patient = await createLoginPatient();
  const currentSlot = await createSlot(doctor.id, { date: dateAfter(30) });
  const targetSlot = await createSlot(doctor.id, { date: dateAfter(31) });

  const appointment = await prisma.appointment.create({
    data: {
      doctorId: doctor.id,
      patientId: patient.user.id,
      slotId: currentSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
      doctorName: doctor.fullName,
      feeAmount: appointmentFeeAmount,
      bookingTime: new Date(),
    },
  });
  await prisma.slot.update({ where: { id: currentSlot.id }, data: { bookedCount: 1 } });

  const payment =
    paymentStatus === null
      ? null
      : await prisma.payment.create({
          data: {
            appointmentId: appointment.id,
            patientId: patient.user.id,
            amountPaise: appointmentFeeAmount,
            currency: "INR",
            status: paymentStatus,
            paymentId: paymentStatus === $Enums.PaymentStatus.PAID ? `pay_day37_${randomUUID()}` : null,
          },
        });

  return { doctor, patient, currentSlot, targetSlot, appointment, payment };
}

beforeAll(async () => {
  await createClinic();
  await setClinicFee(FEE);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 37 chunk 4: reschedule fee deltas and failed-conversion refunds", () => {
  it("keeps the fee snapshot when the doctor's price has not changed", async () => {
    await setClinicFee(FEE);
    const fixture = await createRescheduleFixture(FEE, null);

    const moved = await rescheduleAppointment({
      actor: actorFor(fixture.patient.user),
      appointmentId: fixture.appointment.id,
      slotId: fixture.targetSlot.id,
      reason: "Day 37 zero delta",
      requestId: "day37-zero-delta",
    });

    expect(moved.id).toBe(fixture.appointment.id);
    expect(moved.slotId).toBe(fixture.targetSlot.id);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: fixture.appointment.id } });
    expect(after.feeAmount).toBe(FEE);
    expect(
      await prisma.refund.count({ where: { payment: { appointmentId: fixture.appointment.id } } }),
    ).toBe(0);
  });

  it("rewrites an unpaid pay-at-clinic receivable to the new fee", async () => {
    await setClinicFee(FEE);
    const fixture = await createRescheduleFixture(30_000, $Enums.PaymentStatus.PENDING);
    if (fixture.payment === null) throw new Error("Unpaid fixture must have a pending payment.");

    const moved = await rescheduleAppointment({
      actor: actorFor(fixture.patient.user),
      appointmentId: fixture.appointment.id,
      slotId: fixture.targetSlot.id,
      reason: "Day 37 unpaid delta",
    });

    expect(moved.feeAmount).toBe(FEE);
    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(paymentAfter.amountPaise).toBe(FEE);
    expect(await prisma.refund.count({ where: { paymentId: fixture.payment.id } })).toBe(0);
  });

  it("refuses an upward delta against money already paid", async () => {
    await setClinicFee(FEE);
    const fixture = await createRescheduleFixture(30_000, $Enums.PaymentStatus.PAID);

    const attempt = rescheduleAppointment({
      actor: actorFor(fixture.patient.user),
      appointmentId: fixture.appointment.id,
      slotId: fixture.targetSlot.id,
      reason: "Day 37 paid upward delta",
    });

    await expect(attempt).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: fixture.appointment.id } });
    expect(after.slotId).toBe(fixture.currentSlot.id);
    expect(after.feeAmount).toBe(30_000);
    if (fixture.payment !== null) {
      expect(await prisma.refund.count({ where: { paymentId: fixture.payment.id } })).toBe(0);
    }
  });

  it("queues a RESCHEDULE_DELTA refund for a downward delta against paid money", async () => {
    await setClinicFee(FEE);
    const fixture = await createRescheduleFixture(70_000, $Enums.PaymentStatus.PAID);
    if (fixture.payment === null) throw new Error("Paid fixture must have a paid payment.");

    const moved = await rescheduleAppointment({
      actor: actorFor(fixture.patient.user),
      appointmentId: fixture.appointment.id,
      slotId: fixture.targetSlot.id,
      reason: "Day 37 paid downward delta",
    });

    expect(moved.feeAmount).toBe(FEE);
    const refund = await prisma.refund.findUniqueOrThrow({
      where: {
        paymentId_kind: {
          paymentId: fixture.payment.id,
          kind: $Enums.RefundKind.RESCHEDULE_DELTA,
        },
      },
    });
    expect(refund.amountPaise).toBe(20_000);
    expect(refund.status).toBe($Enums.RefundStatus.PENDING);
  });

  it("settles every step-5 rejection as PAID, no new appointment, and an executed refund", async () => {
    const cases: readonly FailureCase[] = [
      { code: "HOLD_NOT_FOUND", deleteHold: true },
      { code: "HOLD_RELEASED", releaseHold: true },
      { code: "HOLD_EXPIRED", expireHold: true },
      { code: "SLOT_DISABLED", disableSlot: true },
      { code: "DOCTOR_UNAVAILABLE", suspendDoctor: true },
      { code: "ALREADY_BOOKED", prebookSameSlot: true },
      { code: "CONVERSION_FAILED", staleHeldCount: true },
    ];

    for (const testCase of cases) {
      await assertFailureCase(testCase);
    }
  });

  it("returns the same appointment on a converted-order replay without extra writes", async () => {
    const doctor = await createDoctor();
    const patient = await createLoginPatient();
    const slot = await createSlot(doctor.id);
    const order = await createPendingOrder(patient.user.id, slot.id);
    const input: ConvertPaymentInput = {
      orderId: order.orderId,
      gatewayPaymentId: `pay_day37_${randomUUID()}`,
      expectedPatientId: patient.user.id,
      actor: actorFor(patient.user),
      requestId: "day37-replay-first",
    };

    const converted = await convertPayment(input);
    const appointmentsBefore = await prisma.appointment.count({ where: { patientId: patient.user.id } });
    const historyBefore = await prisma.appointmentHistory.count({ where: { appointmentId: converted.id } });
    const bookedAuditsBefore = await prisma.auditLog.count({
      where: { targetType: "appointment", targetId: converted.id, action: "APPOINTMENT_BOOKED" },
    });
    const paidAuditsBefore = await prisma.auditLog.count({
      where: { targetType: "payment", targetId: order.payment.id, action: "PAYMENT_PAID" },
    });

    const replay = await convertPayment({ ...input, gatewayPaymentId: "pay_day37_replay" });
    expect(replay.id).toBe(converted.id);
    expect(await prisma.appointment.count({ where: { patientId: patient.user.id } })).toBe(appointmentsBefore);
    expect(await prisma.appointmentHistory.count({ where: { appointmentId: converted.id } })).toBe(historyBefore);
    expect(
      await prisma.auditLog.count({
        where: { targetType: "appointment", targetId: converted.id, action: "APPOINTMENT_BOOKED" },
      }),
    ).toBe(bookedAuditsBefore);
    expect(
      await prisma.auditLog.count({
        where: { targetType: "payment", targetId: order.payment.id, action: "PAYMENT_PAID" },
      }),
    ).toBe(paidAuditsBefore);
    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: order.payment.id } });
    expect(paymentAfter.paymentId).toBe(input.gatewayPaymentId);
  });
});
