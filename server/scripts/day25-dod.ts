import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { $Enums, PrismaClient } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import type {
  GatewayRefund,
  GatewayRefundParams,
  PaymentGateway,
} from "../src/lib/paymentGateway.js";
import { convertPayment } from "../src/services/paymentConvert.service.js";
import { getClinicSettings } from "../src/services/clinic.service.js";
import { cancelAppointment, rejectAppointment } from "../src/services/appointmentTransition.service.js";
import { rescheduleAppointment } from "../src/services/reschedule.service.js";
import { executePendingRefunds } from "../src/services/refund.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const FIXTURE_EMAIL_PREFIX = "day25-";
const DOCTOR_FEE = 60_000;
const PAID_FEE = 100_000;

class FakeGateway implements PaymentGateway {
  readonly calls: GatewayRefundParams[] = [];

  private readonly delayMs: number;
  private readonly shouldFail: boolean;

  constructor(delayMs = 0, shouldFail = false) {
    this.delayMs = delayMs;
    this.shouldFail = shouldFail;
  }

  async createOrder(): Promise<never> {
    throw new Error("the Day 25 fake gateway does not create orders");
  }

  async refundPayment(params: GatewayRefundParams): Promise<GatewayRefund> {
    this.calls.push(params);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.shouldFail) {
      throw new Error("fake gateway declined the refund");
    }
    return {
      refundId: `rfnd_day25_${this.calls.length}_${params.refundId.slice(0, 8)}`,
      amountPaise: params.amountPaise,
      status: "processed",
    };
  }
}

function fail(message: string): never {
  throw new Error(`FAIL: ${message}`);
}

function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

async function expectRejection(code: string, what: string, fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof AppError)) {
      fail(`${what} threw a non-AppError: ${String(err)}`);
    }
    if (err.code !== code) {
      fail(`expected ${code} for ${what}, got ${err.code}: ${err.message}`);
    }
    return err;
  }
  fail(`expected ${code} for ${what}, but the call succeeded.`);
}

interface RunState {
  readonly userIds: string[];
  readonly patientIds: string[];
  readonly doctorIds: string[];
  readonly slotIds: string[];
}

interface PatientFixture extends ActorContext {
  readonly email: string;
}

async function removeFixtures(state: RunState): Promise<void> {
  if (state.userIds.length === 0 && state.slotIds.length === 0) return;

  const appointments = await prisma.appointment.findMany({
    where: { patientId: { in: state.patientIds } },
    select: { id: true },
  });
  const appointmentIds = appointments.map((row) => row.id);
  const payments = await prisma.payment.findMany({
    where: { patientId: { in: state.patientIds } },
    select: { id: true },
  });
  const paymentIds = payments.map((row) => row.id);
  const refunds = await prisma.refund.findMany({
    where: { paymentId: { in: paymentIds } },
    select: { id: true },
  });
  const refundIds = refunds.map((row) => row.id);
  const targetIds = [...appointmentIds, ...paymentIds, ...refundIds];

  await prisma.notification.deleteMany({ where: { recipient: { startsWith: FIXTURE_EMAIL_PREFIX } } });
  await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.refund.deleteMany({ where: { id: { in: refundIds } } });
  await prisma.seatHold.deleteMany({ where: { patientId: { in: state.patientIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { actorId: { in: state.userIds } },
        { targetId: { in: targetIds } },
      ],
    },
  });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await prisma.slot.deleteMany({ where: { id: { in: state.slotIds } } });
  await prisma.doctorProfile.deleteMany({ where: { userId: { in: state.doctorIds } } });
  await prisma.user.deleteMany({ where: { id: { in: state.userIds } } });
}

async function purgeStaleFixtures(): Promise<number> {
  const staleUsers = await prisma.user.findMany({
    where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } },
    select: { id: true, role: true },
  });
  if (staleUsers.length === 0) return 0;

  const userIds = staleUsers.map((row) => row.id);
  const doctorIds = staleUsers.filter((row) => row.role === $Enums.UserRole.DOCTOR).map((row) => row.id);
  const patientIds = staleUsers.filter((row) => row.role === $Enums.UserRole.PATIENT).map((row) => row.id);
  const staleSlots = await prisma.slot.findMany({ where: { doctorId: { in: doctorIds } }, select: { id: true } });

  await removeFixtures({ userIds, patientIds, doctorIds, slotIds: staleSlots.map((row) => row.id) });
  return staleUsers.length;
}

function timeValue(hhmm: string): Date {
  const [hour, minute] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0));
}

async function main(): Promise<void> {
  const clinic = await getClinicSettings();
  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log(`purged      : ${purged} stale fixture user(s) from a crashed run`);

  const now = Date.now();
  if (clinic.minLeadMinutes >= 48 * 60) fail(`clinic.minLeadMinutes is ${clinic.minLeadMinutes} — 48h out would already be "started".`);
  if (clinic.bookingHorizonDays < 3) fail(`clinic.bookingHorizonDays is ${clinic.bookingHorizonDays} — the fixture window needs at least 3.`);

  const state: RunState = { userIds: [], patientIds: [], doctorIds: [], slotIds: [] };
  const suffix = `${process.pid}-${Date.now().toString().slice(-6)}`;
  const doctorName = "Day25 DoD doctor";

  console.log(`clinic      : ${clinic.name} (${clinic.timezone}, hold ${clinic.holdDurationMinutes}m)`);

  try {
    const doctor = await prisma.user.create({
      data: {
        role: "DOCTOR",
        fullName: doctorName,
        email: `${FIXTURE_EMAIL_PREFIX}doctor-${suffix}@example.test`,
        emailVerifiedAt: new Date(),
        doctorProfile: { create: { verificationStatus: "VERIFIED", consultationFee: DOCTOR_FEE } },
      },
      select: { id: true },
    });
    state.userIds.push(doctor.id);
    state.doctorIds.push(doctor.id);

    async function createSlot(maxPatients: number, offsetHours: number): Promise<{ id: string; startAt: Date }> {
      const startAt = new Date(now + (48 + offsetHours) * 3_600_000);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);
      const localStart = utcToLocalDateTime(startAt, clinic.timezone);
      const localEnd = utcToLocalDateTime(endAt, clinic.timezone);
      const slot = await prisma.slot.create({
        data: {
          doctorId: doctor.id,
          slotDate: new Date(`${localStart.date}T00:00:00.000Z`),
          startTime: timeValue(localStart.time),
          endTime: timeValue(localEnd.time),
          startAt,
          endAt,
          maxPatients,
        },
        select: { id: true, startAt: true },
      });
      state.slotIds.push(slot.id);
      return slot;
    }

    async function createPatient(label: string): Promise<PatientFixture> {
      const email = `${FIXTURE_EMAIL_PREFIX}${label}-${suffix}@example.test`;
      const patient = await prisma.user.create({
        data: {
          role: "PATIENT",
          fullName: `Day25 DoD ${label}`,
          email,
          emailVerifiedAt: new Date(),
        },
        select: { id: true, fullName: true },
      });
      state.userIds.push(patient.id);
      state.patientIds.push(patient.id);
      return { id: patient.id, role: $Enums.UserRole.PATIENT, name: patient.fullName, email };
    }

    async function createStaff(): Promise<ActorContext> {
      const staff = await prisma.user.create({
        data: {
          role: "STAFF",
          fullName: "Day25 DoD staff",
          email: `${FIXTURE_EMAIL_PREFIX}staff-${suffix}@example.test`,
          emailVerifiedAt: new Date(),
        },
        select: { id: true, fullName: true },
      });
      state.userIds.push(staff.id);
      return { id: staff.id, role: $Enums.UserRole.STAFF, name: staff.fullName };
    }

    async function createHeldOrder(input: {
      patient: PatientFixture;
      slotId: string;
      orderId: string;
      expired: boolean;
    }): Promise<{ holdId: string; paymentId: string }> {
      const hold = await prisma.seatHold.create({
        data: {
          patientId: input.patient.id,
          slotId: input.slotId,
          paymentOrderId: input.orderId,
          expiresAt: new Date(input.expired ? now - 60_000 : now + 10 * 60_000),
        },
        select: { id: true },
      });
      const payment = await prisma.payment.create({
        data: {
          patientId: input.patient.id,
          amountPaise: DOCTOR_FEE,
          currency: "INR",
          status: $Enums.PaymentStatus.PENDING,
          orderId: input.orderId,
        },
        select: { id: true },
      });
      await prisma.slot.update({ where: { id: input.slotId }, data: { heldCount: { increment: 1 } } });
      return { holdId: hold.id, paymentId: payment.id };
    }

    async function createPaidAppointment(input: {
      patient: PatientFixture;
      slotId: string;
      label: string;
      amountPaise?: number;
    }): Promise<{ appointmentId: string; paymentId: string }> {
      const amountPaise = input.amountPaise ?? PAID_FEE;
      const appointment = await prisma.appointment.create({
        data: {
          doctorId: doctor.id,
          patientId: input.patient.id,
          slotId: input.slotId,
          status: $Enums.AppointmentStatus.CONFIRMED,
          doctorName,
          feeAmount: amountPaise,
          bookingTime: new Date(),
        },
        select: { id: true },
      });
      const payment = await prisma.payment.create({
        data: {
          appointmentId: appointment.id,
          patientId: input.patient.id,
          amountPaise,
          currency: "INR",
          status: $Enums.PaymentStatus.PAID,
          paymentId: `pay_day25_${input.label}_${suffix}`,
          paidAt: new Date(),
        },
        select: { id: true },
      });
      await prisma.slot.update({ where: { id: input.slotId }, data: { bookedCount: { increment: 1 } } });
      return { appointmentId: appointment.id, paymentId: payment.id };
    }

    async function refundOf(paymentId: string, kind: $Enums.RefundKind) {
      return prisma.refund.findUnique({ where: { paymentId_kind: { paymentId, kind } } });
    }

    async function notificationCount(recipient: string, type: $Enums.NotificationType): Promise<number> {
      return prisma.notification.count({ where: { recipient, type } });
    }

    const staff = await createStaff();

    /* ---------------------------------------------------------------- */
    /* A. Captured money after hold expiry: PAID + refund + seat release. */
    /* ---------------------------------------------------------------- */
    const slotA = await createSlot(2, 0);
    const pLate = await createPatient("late");
    const orderA = `order_day25_late_${suffix}`;
    const heldA = await createHeldOrder({ patient: pLate, slotId: slotA.id, orderId: orderA, expired: true });

    await expectRejection("HOLD_EXPIRED", "a captured payment whose hold expired", () =>
      convertPayment({
        orderId: orderA,
        gatewayPaymentId: `pay_day25_late_${suffix}`,
        expectedPatientId: pLate.id,
        actor: pLate,
        requestId: "day25-dod-late",
      }),
    );

    const paymentA = await prisma.payment.findUnique({ where: { id: heldA.paymentId } });
    expect(paymentA?.status === $Enums.PaymentStatus.PAID, "the captured payment is PAID, never left as if no money moved");
    expect(paymentA?.paymentId === `pay_day25_late_${suffix}` && paymentA.paidAt !== null, "paidAt and the gateway pay id are stored");
    expect(paymentA?.appointmentId === null, "no appointment exists for the failed conversion");
    if (!paymentA) fail("unreachable: payment A missing");

    const holdA = await prisma.seatHold.findUnique({ where: { id: heldA.holdId } });
    expect(holdA?.releaseReason === $Enums.SeatHoldReleaseReason.EXPIRED, "the expired hold is released EXPIRED");
    expect(holdA?.releasedAt !== null, "the release is a timestamped state, not a deletion");
    expect(
      (await prisma.slot.findUnique({ where: { id: slotA.id }, select: { heldCount: true } }))?.heldCount === 0,
      "the held seat is handed back (held 1→0)",
    );

    const refundA = await refundOf(heldA.paymentId, $Enums.RefundKind.EXPIRED_HOLD);
    expect(refundA?.status === $Enums.RefundStatus.PENDING, "a full EXPIRED_HOLD refund is queued PENDING");
    expect(refundA?.amountPaise === DOCTOR_FEE, `the full captured amount is refunded, got ${refundA?.amountPaise ?? "none"}p`);
    if (!refundA) fail("unreachable: refund A missing");
    expect(
      (await prisma.auditLog.count({ where: { action: "PAYMENT_CONVERSION_FAILED", targetId: paymentA.id } })) === 1,
      "the failed conversion is audited",
    );
    expect(
      (await prisma.auditLog.count({ where: { action: "REFUND_QUEUED", targetId: refundA.id } })) === 1,
      "the queued refund is audited",
    );

    const slow = new FakeGateway(30);
    await Promise.all([
      executePendingRefunds({ gateway: slow, limit: 100 }),
      executePendingRefunds({ gateway: slow, limit: 100 }),
    ]);
    expect(slow.calls.length === 1, `a double sweep must call the gateway once, got ${slow.calls.length}`);
    expect(slow.calls[0]?.amountPaise === DOCTOR_FEE && slow.calls[0]?.currency === "INR", "the gateway receives exact paise and currency");
    expect(slow.calls[0]?.refundId === refundA.id, "the local refund id is the gateway correlation id");
    expect(slow.calls[0]?.paymentId === paymentA.paymentId, "the refund targets the stored gateway payment id");

    const refundAAfter = await prisma.refund.findUnique({ where: { id: refundA.id } });
    expect(refundAAfter?.status === $Enums.RefundStatus.SUCCESS, "the refund is SUCCESS");
    expect(refundAAfter?.gatewayRefundId !== null, "the gateway refund id is stored");
    expect((await prisma.payment.findUnique({ where: { id: heldA.paymentId } }))?.status === $Enums.PaymentStatus.PAID, "a refund never rewrites PAID");
    expect(
      (await notificationCount(pLate.email, $Enums.NotificationType.PAYMENT_LATE_REFUND)) === 1,
      "the patient gets the PAYMENT_LATE_REFUND notification",
    );
    expect(
      (await prisma.auditLog.count({ where: { action: "REFUND_SUCCEEDED", targetId: refundA.id } })) === 1,
      "execution is audited as REFUND_SUCCEEDED",
    );

    await executePendingRefunds({ gateway: slow, limit: 100 });
    expect(slow.calls.length === 1, "a completed refund is not sent to the gateway again");
    console.log("late payment: PAID + full EXPIRED_HOLD refund, seat released, one gateway call under a double sweep");

    /* ---------------------------------------------------------------- */
    /* B. Captured money after a live hold broke: CONVERSION_FAILED.     */
    /* ---------------------------------------------------------------- */
    const slotB = await createSlot(2, 1);
    const pBroken = await createPatient("broken");
    const orderB = `order_day25_broken_${suffix}`;
    const heldB = await createHeldOrder({ patient: pBroken, slotId: slotB.id, orderId: orderB, expired: false });
    await prisma.slot.update({ where: { id: slotB.id }, data: { isDisabled: true } });

    await expectRejection("SLOT_DISABLED", "a captured payment for a disabled slot", () =>
      convertPayment({
        orderId: orderB,
        gatewayPaymentId: `pay_day25_broken_${suffix}`,
        expectedPatientId: pBroken.id,
        actor: pBroken,
        requestId: "day25-dod-broken",
      }),
    );

    const holdB = await prisma.seatHold.findUnique({ where: { id: heldB.holdId } });
    expect(holdB?.releaseReason === $Enums.SeatHoldReleaseReason.CONVERSION_FAILED, "the live hold is released CONVERSION_FAILED");
    expect(
      (await prisma.slot.findUnique({ where: { id: slotB.id }, select: { heldCount: true } }))?.heldCount === 0,
      "the broken conversion hands the seat back",
    );
    const refundB = await refundOf(heldB.paymentId, $Enums.RefundKind.CONVERSION_FAILED);
    expect(refundB?.status === $Enums.RefundStatus.PENDING && refundB.amountPaise === DOCTOR_FEE, "a full CONVERSION_FAILED refund is queued");

    const gatewayB = new FakeGateway();
    await executePendingRefunds({ gateway: gatewayB, limit: 100 });
    expect(gatewayB.calls.length === 1, "the generic conversion refund is executed once");
    expect(
      (await notificationCount(pBroken.email, $Enums.NotificationType.REFUND_COMPLETED)) === 1,
      "the generic refund uses REFUND_COMPLETED",
    );
    console.log("broken hold : CONVERSION_FAILED release + full refund + REFUND_COMPLETED notification");

    /* ---------------------------------------------------------------- */
    /* C. Staff cancel: full CLINIC_CAUSED refund, independent of cutoff. */
    /* ---------------------------------------------------------------- */
    const slotC = await createSlot(2, 2);
    const pCancel = await createPatient("cancel");
    const apptC = await createPaidAppointment({ patient: pCancel, slotId: slotC.id, label: "staff-cancel" });
    await cancelAppointment({
      actor: staff,
      appointmentId: apptC.appointmentId,
      reason: "Clinic closure",
      requestId: "day25-dod-staff-cancel",
    });
    const refundC = await refundOf(apptC.paymentId, $Enums.RefundKind.CLINIC_CAUSED);
    expect(refundC?.status === $Enums.RefundStatus.PENDING && refundC.amountPaise === PAID_FEE, "a staff cancel queues a full CLINIC_CAUSED refund");
    expect(
      (await prisma.slot.findUnique({ where: { id: slotC.id }, select: { bookedCount: true } }))?.bookedCount === 0,
      "the cancelled appointment frees its seat",
    );
    const gatewayC = new FakeGateway();
    await executePendingRefunds({ gateway: gatewayC, limit: 100 });
    expect(gatewayC.calls.length === 1, "the clinic-caused refund is executed once");
    expect(
      (await notificationCount(pCancel.email, $Enums.NotificationType.REFUND_COMPLETED)) === 1,
      "the cancelled patient gets REFUND_COMPLETED",
    );

    /* ---------------------------------------------------------------- */
    /* D. Patient cancel inside cutoff: CANCELLATION, not clinic-caused. */
    /* ---------------------------------------------------------------- */
    const slotD = await createSlot(2, 3);
    const pSelf = await createPatient("self-cancel");
    const apptD = await createPaidAppointment({ patient: pSelf, slotId: slotD.id, label: "patient-cancel" });
    await cancelAppointment({
      actor: pSelf,
      appointmentId: apptD.appointmentId,
      reason: null,
      requestId: "day25-dod-patient-cancel",
    });
    const refundD = await refundOf(apptD.paymentId, $Enums.RefundKind.CANCELLATION);
    expect(refundD?.status === $Enums.RefundStatus.PENDING && refundD.amountPaise === PAID_FEE, "a patient cancel inside the cutoff queues CANCELLATION");
    expect(
      (await refundOf(apptD.paymentId, $Enums.RefundKind.CLINIC_CAUSED)) === null,
      "a patient's ordinary cancellation is not mislabelled CLINIC_CAUSED",
    );
    const gatewayD = new FakeGateway();
    await executePendingRefunds({ gateway: gatewayD, limit: 100 });
    expect(gatewayD.calls.length === 1, "the patient-cancellation refund is executed once");
    console.log("cancels     : staff → CLINIC_CAUSED, patient → CANCELLATION, both executed");

    /* ---------------------------------------------------------------- */
    /* E. Staff reject: CLINIC_CAUSED, the Day 21 deferred refund.       */
    /* ---------------------------------------------------------------- */
    const slotE = await createSlot(2, 4);
    const pReject = await createPatient("reject");
    const apptE = await createPaidAppointment({ patient: pReject, slotId: slotE.id, label: "reject" });
    await rejectAppointment({
      actor: staff,
      appointmentId: apptE.appointmentId,
      reason: "Not eligible for this clinic",
      requestId: "day25-dod-reject",
    });
    const refundE = await refundOf(apptE.paymentId, $Enums.RefundKind.CLINIC_CAUSED);
    expect(refundE?.status === $Enums.RefundStatus.PENDING && refundE.amountPaise === PAID_FEE, "a rejection queues a full CLINIC_CAUSED refund");
    const gatewayE = new FakeGateway();
    await executePendingRefunds({ gateway: gatewayE, limit: 100 });
    expect(gatewayE.calls.length === 1, "the rejection refund is executed once");
    console.log("reject      : full CLINIC_CAUSED refund, the Day 21 deferral is closed");

    /* ---------------------------------------------------------------- */
    /* F. Cheaper reschedule delta, then cancel: remaining only.         */
    /* ---------------------------------------------------------------- */
    const slotOld = await createSlot(2, 5);
    const slotNew = await createSlot(2, 6);
    const pMove = await createPatient("reschedule");
    const apptF = await createPaidAppointment({ patient: pMove, slotId: slotOld.id, label: "reschedule" });
    const moved = await rescheduleAppointment({
      actor: staff,
      appointmentId: apptF.appointmentId,
      slotId: slotNew.id,
      reason: "Doctor moved to a shorter slot",
      requestId: "day25-dod-reschedule",
    });
    expect(moved.slotId === slotNew.id && moved.feeAmount === DOCTOR_FEE, "the paid booking moved to the cheaper slot");
    const deltaF = await refundOf(apptF.paymentId, $Enums.RefundKind.RESCHEDULE_DELTA);
    expect(deltaF?.status === $Enums.RefundStatus.PENDING && deltaF.amountPaise === PAID_FEE - DOCTOR_FEE, "the delta refund is the fee difference");

    const gatewayF = new FakeGateway();
    await executePendingRefunds({ gateway: gatewayF, limit: 100 });
    expect(gatewayF.calls.length === 1 && gatewayF.calls[0]?.amountPaise === PAID_FEE - DOCTOR_FEE, "the delta is executed at its own amount");

    await cancelAppointment({
      actor: pMove,
      appointmentId: apptF.appointmentId,
      reason: null,
      requestId: "day25-dod-cancel-after-reschedule",
    });
    const cancelF = await refundOf(apptF.paymentId, $Enums.RefundKind.CANCELLATION);
    expect(cancelF?.status === $Enums.RefundStatus.PENDING, "the later cancellation queues its own refund");
    expect(cancelF?.amountPaise === DOCTOR_FEE, `the later cancellation refunds only the unrefunded remainder (${DOCTOR_FEE}p), got ${cancelF?.amountPaise ?? "none"}p`);

    const gatewayF2 = new FakeGateway();
    await executePendingRefunds({ gateway: gatewayF2, limit: 100 });
    expect(gatewayF2.calls.length === 1 && gatewayF2.calls[0]?.amountPaise === DOCTOR_FEE, "the remainder is executed once");
    const allF = await prisma.refund.findMany({ where: { paymentId: apptF.paymentId }, select: { status: true, amountPaise: true } });
    expect(allF.length === 2 && allF.every((row) => row.status === $Enums.RefundStatus.SUCCESS), "both refunds succeed");
    expect(allF.reduce((sum, row) => sum + row.amountPaise, 0) === PAID_FEE, "the two refunds sum to exactly the amount captured");
    console.log("reschedule  : 40,000p delta + 60,000p cancellation = 100,000p captured, never 140,000p");

    /* ---------------------------------------------------------------- */
    /* G. Gateway failure: visible FAILED row, no automatic retry.       */
    /* ---------------------------------------------------------------- */
    const slotG = await createSlot(2, 7);
    const pFail = await createPatient("gateway-fail");
    const apptG = await createPaidAppointment({ patient: pFail, slotId: slotG.id, label: "gateway-fail" });
    await cancelAppointment({
      actor: staff,
      appointmentId: apptG.appointmentId,
      reason: "Clinic closure",
      requestId: "day25-dod-gateway-fail",
    });
    const failing = new FakeGateway(0, true);
    await executePendingRefunds({ gateway: failing, limit: 100 });
    const refundG = await refundOf(apptG.paymentId, $Enums.RefundKind.CLINIC_CAUSED);
    expect(refundG?.status === $Enums.RefundStatus.FAILED, "a gateway refusal leaves the refund FAILED, visible in the queue");
    expect(refundG?.gatewayRefundId === null, "a failed refund has no gateway refund id");
    if (!refundG) fail("unreachable: refund G missing");
    expect(
      (await prisma.auditLog.count({ where: { action: "REFUND_FAILED", targetId: refundG.id } })) === 1,
      "the failure is audited",
    );
    const retry = new FakeGateway();
    await executePendingRefunds({ gateway: retry, limit: 100 });
    expect(retry.calls.length === 0, "FAILED is not auto-retried by the sweep; retry belongs to the Day 26 admin queue");
    console.log("failure     : FAILED row visible, REFUND_FAILED audited, no silent automatic retry");

    console.log("");
    console.log("Day 25 DoD passed — failure settlement, full/partial refunds, idempotent execution and failure visibility.");
  } finally {
    await removeFixtures(state);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
