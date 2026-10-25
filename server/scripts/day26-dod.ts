// Day 26 DoD against the real local database:
//
//   npx tsx scripts/day26-dod.ts
//
// Proves the pay-at-clinic half of §17:
//
//   A. Booking creates one PENDING receivable; STAFF/ADMIN collect it as
//      CASH/CARD/UPI, with method, collector and timestamp recorded.
//   B. A concession collects less than the fee; the receipt amount drives the
//      later cheaper-reschedule delta, not the old fee snapshot.
//   C. The desk can void an unpaid receivable; it is never refunded as if
//      money had moved.
//   D. Cancel/reject/write-off has one money rule: PENDING → VOIDED, PAID →
//      refund (hand-back for offline money).
//   E. A clinic-caused auto-cancel does the same at slot end for both unpaid
//      and paid bookings.
//   F. RefundKind survives: RESCHEDULE_DELTA and CANCELLATION remain distinct
//      against one offline payment, and hand-back completes without a gateway.
//   G. ADMIN retry moves a FAILED gateway refund back to PENDING; offline
//      hand-backs use the desk queue instead.
//   H. Collection and cancellation racing on one appointment serialize: either
//      money is PAID and a hand-back is queued, or the receivable is VOIDED and
//      collection refuses. There is never a PENDING payment on a cancelled row.
//
// Clean-up removes every fixture this run creates (users, doctor profile,
// slots, appointments, payments, refunds, notifications, histories, holds,
// unavailability rows and audit rows) in a `finally`.

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
import { getClinicSettings } from "../src/services/clinic.service.js";
import { bookAppointment } from "../src/services/booking.service.js";
import { autoCancelAfterSlotEnd } from "../src/services/appointmentCascade.service.js";
import { cancelAppointment } from "../src/services/appointmentTransition.service.js";
import { collectOfflinePayment, voidOfflinePayment } from "../src/services/offlinePayment.service.js";
import {
  completeDeskHandBack,
  executeRefund,
  listPendingDeskHandBacks,
  retryFailedRefund,
} from "../src/services/refund.service.js";
import { rescheduleAppointment } from "../src/services/reschedule.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const FIXTURE_EMAIL_PREFIX = "day26-";
const DOCTOR_FEE = 75_000;
const CHEAPER_FEE = 50_000;
const COLLECTED_LESS = 60_000;

class FakeGateway implements PaymentGateway {
  readonly calls: GatewayRefundParams[] = [];

  private readonly shouldFail: boolean;

  constructor(shouldFail = false) {
    this.shouldFail = shouldFail;
  }

  async createOrder(): Promise<never> {
    throw new Error("the Day 26 fake gateway does not create orders");
  }

  async refundPayment(params: GatewayRefundParams): Promise<GatewayRefund> {
    this.calls.push(params);
    if (this.shouldFail) {
      throw new Error("fake gateway declined the refund");
    }
    return {
      refundId: `rfnd_day26_${this.calls.length}_${params.refundId.slice(0, 8)}`,
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
  readonly unavailabilityIds: string[];
}

interface PatientFixture extends ActorContext {
  readonly email: string;
}

async function removeFixtures(state: RunState): Promise<void> {
  if (state.userIds.length === 0 && state.slotIds.length === 0) return;

  const appointments = await prisma.appointment.findMany({
    where: {
      OR: [
        { patientId: { in: state.patientIds } },
        { slotId: { in: state.slotIds } },
        { doctorId: { in: state.doctorIds } },
      ],
    },
    select: { id: true },
  });
  const appointmentIds = appointments.map((row) => row.id);

  const payments = await prisma.payment.findMany({
    where: {
      OR: [{ patientId: { in: state.patientIds } }, { appointmentId: { in: appointmentIds } }],
    },
    select: { id: true },
  });
  const paymentIds = payments.map((row) => row.id);

  const refunds = await prisma.refund.findMany({
    where: { paymentId: { in: paymentIds } },
    select: { id: true },
  });
  const refundIds = refunds.map((row) => row.id);
  const targetIds = [...appointmentIds, ...paymentIds, ...refundIds];

  await prisma.notification.deleteMany({
    where: {
      OR: [
        { appointmentId: { in: appointmentIds } },
        { recipient: { startsWith: FIXTURE_EMAIL_PREFIX } },
      ],
    },
  });
  await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.refund.deleteMany({ where: { id: { in: refundIds } } });
  await prisma.seatHold.deleteMany({ where: { patientId: { in: state.patientIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [{ actorId: { in: state.userIds } }, { targetId: { in: targetIds } }],
    },
  });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await prisma.doctorUnavailability.deleteMany({
    where: {
      OR: [
        { id: { in: state.unavailabilityIds } },
        { doctorId: { in: state.doctorIds } },
        { createdById: { in: state.userIds } },
      ],
    },
  });
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
  const staleUnavailability = await prisma.doctorUnavailability.findMany({
    where: { OR: [{ doctorId: { in: doctorIds } }, { createdById: { in: userIds } }] },
    select: { id: true },
  });

  await removeFixtures({
    userIds,
    patientIds,
    doctorIds,
    slotIds: staleSlots.map((row) => row.id),
    unavailabilityIds: staleUnavailability.map((row) => row.id),
  });
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

  const state: RunState = { userIds: [], patientIds: [], doctorIds: [], slotIds: [], unavailabilityIds: [] };
  const suffix = `${process.pid}-${Date.now().toString().slice(-6)}`;

  console.log(`clinic      : ${clinic.name} (${clinic.timezone})`);

  try {
    async function createDoctor(label: string, fee: number): Promise<ActorContext> {
      const user = await prisma.user.create({
        data: {
          role: "DOCTOR",
          fullName: `Day26 DoD ${label}`,
          email: `${FIXTURE_EMAIL_PREFIX}doctor-${label}-${suffix}@example.test`,
          emailVerifiedAt: new Date(),
          doctorProfile: { create: { verificationStatus: "VERIFIED", consultationFee: fee } },
        },
        select: { id: true, fullName: true },
      });
      state.userIds.push(user.id);
      state.doctorIds.push(user.id);
      return { id: user.id, role: $Enums.UserRole.DOCTOR, name: user.fullName };
    }

    async function createActor(role: $Enums.UserRole, label: string): Promise<ActorContext> {
      const user = await prisma.user.create({
        data: {
          role,
          fullName: `Day26 DoD ${label}`,
          email: `${FIXTURE_EMAIL_PREFIX}${label}-${suffix}@example.test`,
          emailVerifiedAt: new Date(),
        },
        select: { id: true, fullName: true },
      });
      state.userIds.push(user.id);
      return { id: user.id, role, name: user.fullName };
    }

    async function createSlot(
      doctorId: string,
      maxPatients: number,
      offsetHours: number,
    ): Promise<{ id: string; startAt: Date; endAt: Date }> {
      const startAt = new Date(now + (48 + offsetHours) * 3_600_000);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);
      const localStart = utcToLocalDateTime(startAt, clinic.timezone);
      const localEnd = utcToLocalDateTime(endAt, clinic.timezone);
      const slot = await prisma.slot.create({
        data: {
          doctorId,
          slotDate: new Date(`${localStart.date}T00:00:00.000Z`),
          startTime: timeValue(localStart.time),
          endTime: timeValue(localEnd.time),
          startAt,
          endAt,
          maxPatients,
        },
        select: { id: true, startAt: true, endAt: true },
      });
      state.slotIds.push(slot.id);
      return slot;
    }

    async function createPatient(label: string): Promise<PatientFixture> {
      const email = `${FIXTURE_EMAIL_PREFIX}${label}-${suffix}@example.test`;
      const user = await prisma.user.create({
        data: {
          role: "PATIENT",
          fullName: `Day26 DoD ${label}`,
          email,
          emailVerifiedAt: new Date(),
        },
        select: { id: true, fullName: true },
      });
      state.userIds.push(user.id);
      state.patientIds.push(user.id);
      return { id: user.id, role: $Enums.UserRole.PATIENT, name: user.fullName, email };
    }

    async function paymentOf(appointmentId: string) {
      return prisma.payment.findFirst({
        where: { appointmentId },
        orderBy: { createdAt: "desc" },
      });
    }

    async function refundOf(paymentId: string, kind: $Enums.RefundKind) {
      return prisma.refund.findUnique({ where: { paymentId_kind: { paymentId, kind } } });
    }

    async function notificationCount(recipient: string, type: $Enums.NotificationType): Promise<number> {
      return prisma.notification.count({ where: { recipient, type } });
    }

    const doctor = await createDoctor("doctor", DOCTOR_FEE);
    const cheaperDoctor = await createDoctor("cheaper", CHEAPER_FEE);
    const staff = await createActor($Enums.UserRole.STAFF, "staff");
    const admin = await createActor($Enums.UserRole.ADMIN, "admin");

    /* ---------------------------------------------------------------- */
    /* A. Booking creates a receivable; the desk collects it.            */
    /* ---------------------------------------------------------------- */
    const slotA = await createSlot(doctor.id, 2, 0);
    const pA = await createPatient("collect");
    const apptA = await bookAppointment({ actor: pA, slotId: slotA.id, requestId: "day26-dod-book" });
    const paymentA = await paymentOf(apptA.id);
    expect(paymentA !== null, "booking creates a Payment row");
    if (!paymentA) fail("unreachable: payment A missing");
    expect(paymentA.status === $Enums.PaymentStatus.PENDING, "the receivable is born PENDING");
    expect(paymentA.amountPaise === DOCTOR_FEE, `the receivable is the booking fee (${DOCTOR_FEE}p), got ${paymentA.amountPaise}p`);
    expect(paymentA.method === null && paymentA.paymentId === null && paymentA.orderId === null, "offline money has no method or gateway ids yet");
    expect(paymentA.collectedById === null && paymentA.collectedAt === null && paymentA.paidAt === null, "nothing is collected at booking");

    await expectRejection("FORBIDDEN", "a patient collecting their own receivable", () =>
      collectOfflinePayment({ actor: pA, appointmentId: apptA.id, method: $Enums.PaymentMethod.CASH }),
    );

    const collectedA = await collectOfflinePayment({
      actor: staff,
      appointmentId: apptA.id,
      method: $Enums.PaymentMethod.CASH,
      requestId: "day26-dod-collect",
    });
    expect(collectedA.status === $Enums.PaymentStatus.PAID && collectedA.amountPaise === DOCTOR_FEE, "staff collection marks the row PAID");
    expect(collectedA.method === $Enums.PaymentMethod.CASH, "the collected method is stored");
    expect(collectedA.collectedById === staff.id && collectedA.collectedAt !== null && collectedA.paidAt !== null, "collector and both money timestamps are stored");
    expect(await notificationCount(pA.email, $Enums.NotificationType.PAYMENT_SUCCESSFUL) === 1, "collection queues PAYMENT_SUCCESSFUL");
    expect(await prisma.auditLog.count({ where: { action: "PAYMENT_COLLECTED", targetId: paymentA.id } }) === 1, "collection is audited");
    await expectRejection("PAYMENT_NOT_PENDING", "collecting twice", () =>
      collectOfflinePayment({ actor: staff, appointmentId: apptA.id, method: $Enums.PaymentMethod.UPI }),
    );
    console.log("collect     : booking receivable → PAID with method, collector, timestamps, notification and audit");

    /* ---------------------------------------------------------------- */
    /* B. A concession is the refund baseline; policy kind survives.     */
    /* ---------------------------------------------------------------- */
    const slotB = await createSlot(doctor.id, 2, 1);
    const slotB2 = await createSlot(cheaperDoctor.id, 2, 2);
    const pB = await createPatient("concession");
    const apptB = await bookAppointment({ actor: pB, slotId: slotB.id, requestId: "day26-dod-concession-book" });
    const paymentB = await paymentOf(apptB.id);
    if (!paymentB) fail("unreachable: payment B missing");

    const collectedB = await collectOfflinePayment({
      actor: staff,
      appointmentId: apptB.id,
      method: $Enums.PaymentMethod.UPI,
      amountPaise: COLLECTED_LESS,
      requestId: "day26-dod-concession-collect",
    });
    expect(collectedB.amountPaise === COLLECTED_LESS, "a concession stores what was actually collected, not the old fee");

    const movedB = await rescheduleAppointment({
      actor: staff,
      appointmentId: apptB.id,
      slotId: slotB2.id,
      reason: "Moved to the cheaper doctor",
      requestId: "day26-dod-offline-reschedule",
    });
    expect(movedB.feeAmount === CHEAPER_FEE && movedB.slotId === slotB2.id, "the offline booking moves to the cheaper fee");
    const deltaB = await refundOf(paymentB.id, $Enums.RefundKind.RESCHEDULE_DELTA);
    expect(deltaB !== null, "the cheaper reschedule queues a refund against the offline payment");
    if (!deltaB) fail("unreachable: delta B missing");
    expect(deltaB.amountPaise === COLLECTED_LESS - CHEAPER_FEE, `the delta uses actual collected money (${COLLECTED_LESS - CHEAPER_FEE}p), got ${deltaB.amountPaise}p`);
    expect(paymentB.paymentId === null && deltaB.paymentId === paymentB.id, "the refund points at the local offline payment, which is how the queue identifies it");
    expect(deltaB.status === $Enums.RefundStatus.PENDING && deltaB.gatewayRefundId === null, "the hand-back is pending and has no gateway refund id");
    expect(await prisma.refund.count({ where: { paymentId: paymentB.id, kind: $Enums.RefundKind.DESK_HAND_BACK } }) === 0, "the policy kind is preserved, not overwritten with DESK_HAND_BACK");

    const queueB = await listPendingDeskHandBacks();
    const queueRowB = queueB.find((row) => row.refundId === deltaB.id);
    expect(queueRowB !== undefined, "the pending delta appears in the desk hand-back queue");
    expect(queueRowB?.kind === $Enums.RefundKind.RESCHEDULE_DELTA, "the queue row says why the money is owed");
    expect(queueRowB?.patientName === pB.name && queueRowB.patientId === pB.id, "the queue row identifies the patient");

    await expectRejection("FORBIDDEN", "a patient completing a desk hand-back", () =>
      completeDeskHandBack({ refundId: deltaB.id, method: $Enums.PaymentMethod.CASH, actor: pB }),
    );

    const handedB = await completeDeskHandBack({
      refundId: deltaB.id,
      method: $Enums.PaymentMethod.CASH,
      actor: admin,
      requestId: "day26-dod-hand-back",
    });
    expect(handedB.status === $Enums.RefundStatus.SUCCESS && handedB.amountPaise === COLLECTED_LESS - CHEAPER_FEE, "the hand-back completes for the exact queued amount");
    const deltaBAfter = await prisma.refund.findUnique({ where: { id: deltaB.id } });
    expect(deltaBAfter?.method === $Enums.PaymentMethod.CASH, "the hand-back method is stored");
    expect(deltaBAfter?.actorId === admin.id && deltaBAfter.actorRole === $Enums.UserRole.ADMIN && deltaBAfter.actorName === admin.name, "the hand-back actor replaces the queueing actor");
    expect(deltaBAfter?.gatewayRefundId === null, "no gateway id is invented for physical money");
    expect(await notificationCount(pB.email, $Enums.NotificationType.REFUND_COMPLETED) === 1, "the hand-back queues REFUND_COMPLETED");
    expect(await prisma.auditLog.count({ where: { action: "REFUND_HANDED_BACK", targetId: deltaB.id } }) === 1, "the hand-back is audited");
    await expectRejection("REFUND_NOT_PENDING", "handing back the same refund twice", () =>
      completeDeskHandBack({ refundId: deltaB.id, method: $Enums.PaymentMethod.UPI, actor: staff }),
    );
    await expectRejection("REFUND_NOT_GATEWAY", "retrying an offline hand-back through the gateway path", () =>
      retryFailedRefund({ refundId: deltaB.id, actor: admin }),
    );

    await cancelAppointment({
      actor: pB,
      appointmentId: apptB.id,
      reason: null,
      requestId: "day26-dod-cancel-after-reschedule",
    });
    const cancelB = await refundOf(paymentB.id, $Enums.RefundKind.CANCELLATION);
    expect(cancelB !== null, "the later cancellation queues its own policy kind");
    if (!cancelB) fail("unreachable: cancellation B missing");
    expect(cancelB.amountPaise === CHEAPER_FEE, `cancellation refunds only the unrefunded remainder (${CHEAPER_FEE}p), got ${cancelB.amountPaise}p`);
    expect(cancelB.paymentId === paymentB.id && cancelB.status === $Enums.RefundStatus.PENDING, "the remainder is another pending desk hand-back");
    await completeDeskHandBack({ refundId: cancelB.id, method: $Enums.PaymentMethod.UPI, actor: staff, requestId: "day26-dod-cancel-hand-back" });
    const allB = await prisma.refund.findMany({ where: { paymentId: paymentB.id }, select: { amountPaise: true, status: true, kind: true } });
    expect(allB.length === 2, "delta and cancellation are two refund rows, not one collapsed row");
    expect(allB.every((row) => row.status === $Enums.RefundStatus.SUCCESS), "both hand-backs are complete");
    expect(allB.reduce((sum, row) => sum + row.amountPaise, 0) === COLLECTED_LESS, "the two hand-backs sum to exactly the cash collected");
    console.log("reschedule  : 60,000p collected − 50,000p fee = 10,000p hand-back; later cancel hands back 50,000p");

    /* ---------------------------------------------------------------- */
    /* B2. An unpaid receivable follows a cheaper reschedule.            */
    /* ---------------------------------------------------------------- */
    const slotPendingOld = await createSlot(doctor.id, 2, 8);
    const slotPendingNew = await createSlot(cheaperDoctor.id, 2, 9);
    const pPendingMove = await createPatient("pending-reschedule");
    const apptPendingMove = await bookAppointment({
      actor: pPendingMove,
      slotId: slotPendingOld.id,
      requestId: "day26-dod-pending-reschedule-book",
    });
    const paymentPendingMove = await paymentOf(apptPendingMove.id);
    if (!paymentPendingMove) fail("unreachable: pending reschedule payment missing");
    expect(paymentPendingMove.status === $Enums.PaymentStatus.PENDING && paymentPendingMove.amountPaise === DOCTOR_FEE, "unpaid booking starts at the old fee");

    const movedPending = await rescheduleAppointment({
      actor: staff,
      appointmentId: apptPendingMove.id,
      slotId: slotPendingNew.id,
      reason: "Move before paying",
      requestId: "day26-dod-pending-reschedule",
    });
    expect(movedPending.feeAmount === CHEAPER_FEE, "the unpaid booking moves to the cheaper fee");
    const paymentPendingAfter = await prisma.payment.findUnique({ where: { id: paymentPendingMove.id } });
    expect(paymentPendingAfter?.status === $Enums.PaymentStatus.PENDING, "the receivable stays unpaid after reschedule");
    expect(paymentPendingAfter?.amountPaise === CHEAPER_FEE, `the unpaid receivable follows the new fee (${CHEAPER_FEE}p), got ${paymentPendingAfter?.amountPaise ?? "none"}p`);
    expect(await prisma.refund.count({ where: { paymentId: paymentPendingMove.id } }) === 0, "an unpaid reschedule has no refund");
    expect(await prisma.auditLog.count({ where: { action: "PAYMENT_AMOUNT_ADJUSTED", targetId: paymentPendingMove.id } }) === 1, "the amount adjustment is audited");
    console.log("unpaid move : receivable follows the new fee, no money and no refund involved");

    /* ---------------------------------------------------------------- */
    /* C. The desk can void an unpaid receivable.                        */
    /* ---------------------------------------------------------------- */
    const slotC = await createSlot(doctor.id, 2, 3);
    const pC = await createPatient("void");
    const apptC = await bookAppointment({ actor: pC, slotId: slotC.id, requestId: "day26-dod-void-book" });
    const paymentC = await paymentOf(apptC.id);
    if (!paymentC) fail("unreachable: payment C missing");

    const voidedC = await voidOfflinePayment({ actor: staff, appointmentId: apptC.id, reason: "Desk write-off" });
    expect(voidedC.status === $Enums.PaymentStatus.VOIDED && voidedC.method === null, "voiding leaves an unpaid row VOIDED and methodless");
    expect(await prisma.auditLog.count({ where: { action: "PAYMENT_VOIDED", targetId: paymentC.id } }) === 1, "the void is audited");
    await expectRejection("PAYMENT_NOT_PENDING", "collecting after a void", () =>
      collectOfflinePayment({ actor: staff, appointmentId: apptC.id, method: $Enums.PaymentMethod.CASH }),
    );
    await expectRejection("PAYMENT_NOT_PENDING", "voiding twice", () =>
      voidOfflinePayment({ actor: staff, appointmentId: apptC.id, reason: "Again" }),
    );
    console.log("void        : unpaid receivable → VOIDED, never refunded or collected");

    /* ---------------------------------------------------------------- */
    /* D. Cancel closes an unpaid booking without a refund.              */
    /* ---------------------------------------------------------------- */
    const slotD = await createSlot(doctor.id, 2, 4);
    const pD = await createPatient("cancel-unpaid");
    const apptD = await bookAppointment({ actor: pD, slotId: slotD.id, requestId: "day26-dod-cancel-unpaid-book" });
    const paymentD = await paymentOf(apptD.id);
    if (!paymentD) fail("unreachable: payment D missing");

    await cancelAppointment({
      actor: staff,
      appointmentId: apptD.id,
      reason: "Clinic policy",
      requestId: "day26-dod-cancel-unpaid",
    });
    const paymentDAfter = await prisma.payment.findUnique({ where: { id: paymentD.id } });
    expect(paymentDAfter?.status === $Enums.PaymentStatus.VOIDED, "cancelling an unpaid booking voids the receivable");
    expect(await prisma.refund.count({ where: { paymentId: paymentD.id } }) === 0, "voided money never becomes a refund");
    expect(await prisma.auditLog.count({ where: { action: "PAYMENT_VOIDED", targetId: paymentD.id } }) === 1, "the transition's void is audited");
    expect((await prisma.slot.findUnique({ where: { id: slotD.id }, select: { bookedCount: true } }))?.bookedCount === 0, "cancelling still frees the seat");
    console.log("cancel      : unpaid PENDING → VOIDED, no refund, seat freed");

    /* ---------------------------------------------------------------- */
    /* E. Auto-cancel at slot end handles unpaid and paid.               */
    /* ---------------------------------------------------------------- */
    const slotE = await createSlot(doctor.id, 2, 5);
    const pEUnpaid = await createPatient("auto-unpaid");
    const pEPaid = await createPatient("auto-paid");
    const apptEUnpaid = await bookAppointment({ actor: pEUnpaid, slotId: slotE.id, requestId: "day26-dod-auto-unpaid" });
    const apptEPaid = await bookAppointment({ actor: pEPaid, slotId: slotE.id, requestId: "day26-dod-auto-paid" });
    const paymentEUnpaid = await paymentOf(apptEUnpaid.id);
    const paymentEPaid = await paymentOf(apptEPaid.id);
    if (!paymentEUnpaid || !paymentEPaid) fail("unreachable: auto-cancel payments missing");

    await collectOfflinePayment({ actor: staff, appointmentId: apptEPaid.id, method: $Enums.PaymentMethod.CARD });
    const disruption = await prisma.doctorUnavailability.create({
      data: {
        doctorId: doctor.id,
        createdById: admin.id,
        startAt: new Date(now + 52 * 3_600_000),
        endAt: new Date(now + 55 * 3_600_000),
        reason: "Day26 DoD simulated clinic closure",
      },
      select: { id: true },
    });
    state.unavailabilityIds.push(disruption.id);
    await prisma.appointment.updateMany({
      where: { id: { in: [apptEUnpaid.id, apptEPaid.id] } },
      data: { doctorUnavailabilityId: disruption.id },
    });
    const pastStart = new Date(now - 2 * 3_600_000);
    const pastEnd = new Date(now - 3_600_000);
    await prisma.slot.update({ where: { id: slotE.id }, data: { startAt: pastStart, endAt: pastEnd } });

    const auto = await autoCancelAfterSlotEnd(new Date(now));
    expect(auto.cancelledAppointmentIds.includes(apptEUnpaid.id), "auto-cancel closes the unpaid clinic-caused booking");
    expect(auto.cancelledAppointmentIds.includes(apptEPaid.id), "auto-cancel closes the paid clinic-caused booking");
    expect((await prisma.payment.findUnique({ where: { id: paymentEUnpaid.id } }))?.status === $Enums.PaymentStatus.VOIDED, "auto-cancel voids the unpaid receivable");
    expect((await prisma.payment.findUnique({ where: { id: paymentEPaid.id } }))?.status === $Enums.PaymentStatus.PAID, "auto-cancel never rewrites paid money");
    const autoRefund = await refundOf(paymentEPaid.id, $Enums.RefundKind.CLINIC_CAUSED);
    expect(autoRefund?.status === $Enums.RefundStatus.PENDING && autoRefund.amountPaise === DOCTOR_FEE, "auto-cancel queues a full clinic-caused hand-back for paid money");
    if (!autoRefund) fail("unreachable: auto-cancel refund missing");
    await completeDeskHandBack({ refundId: autoRefund.id, method: $Enums.PaymentMethod.UPI, actor: admin });
    expect((await prisma.slot.findUnique({ where: { id: slotE.id }, select: { bookedCount: true } }))?.bookedCount === 0, "both auto-cancels free their seats");
    console.log("auto-cancel : unpaid → VOIDED, paid → CLINIC_CAUSED hand-back, seats freed");

    /* ---------------------------------------------------------------- */
    /* F. Failed gateway refund → ADMIN retry → success.                 */
    /* ---------------------------------------------------------------- */
    const slotF = await createSlot(doctor.id, 2, 6);
    const pF = await createPatient("retry-gateway");
    const apptF = await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: pF.id,
        slotId: slotF.id,
        status: $Enums.AppointmentStatus.CONFIRMED,
        doctorName: doctor.name,
        feeAmount: DOCTOR_FEE,
        bookingTime: new Date(),
      },
      select: { id: true },
    });
    const paymentF = await prisma.payment.create({
      data: {
        appointmentId: apptF.id,
        patientId: pF.id,
        amountPaise: DOCTOR_FEE,
        currency: "INR",
        status: $Enums.PaymentStatus.PAID,
        method: $Enums.PaymentMethod.UPI,
        paymentId: `pay_day26_retry_${suffix}`,
        paidAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.slot.update({ where: { id: slotF.id }, data: { bookedCount: { increment: 1 } } });

    await cancelAppointment({
      actor: staff,
      appointmentId: apptF.id,
      reason: "Clinic closure",
      requestId: "day26-dod-retry-cancel",
    });
    const refundF = await refundOf(paymentF.id, $Enums.RefundKind.CLINIC_CAUSED);
    if (!refundF) fail("unreachable: retry refund missing");

    const failing = new FakeGateway(true);
    const failure = await executeRefund(refundF.id, { gateway: failing });
    expect(failure.outcome === "failed", "the fake gateway failure is reported");
    expect((await prisma.refund.findUnique({ where: { id: refundF.id } }))?.status === $Enums.RefundStatus.FAILED, "the gateway refusal leaves FAILED");
    await expectRejection("REFUND_NOT_OFFLINE", "completing a failed online refund at the desk", () =>
      completeDeskHandBack({ refundId: refundF.id, method: $Enums.PaymentMethod.CASH, actor: staff }),
    );

    await expectRejection("FORBIDDEN", "a staff member retrying a failed gateway refund", () =>
      retryFailedRefund({ refundId: refundF.id, actor: staff }),
    );
    const retried = await retryFailedRefund({ refundId: refundF.id, actor: admin, requestId: "day26-dod-retry" });
    expect(retried.outcome === "retry_queued", "ADMIN retry requeues the refund");
    expect((await prisma.refund.findUnique({ where: { id: refundF.id } }))?.status === $Enums.RefundStatus.PENDING, "retry moves FAILED → PENDING");
    expect(await prisma.auditLog.count({ where: { action: "REFUND_RETRY_REQUESTED", targetId: refundF.id } }) === 1, "the retry is audited");

    const retryGateway = new FakeGateway();
    const retryResult = await executeRefund(refundF.id, { gateway: retryGateway });
    expect(retryResult.outcome === "success" && retryGateway.calls.length === 1, "the retried gateway refund succeeds exactly once");
    expect(retryGateway.calls[0]?.amountPaise === DOCTOR_FEE, "the retry sends the original refund amount");
    await expectRejection("REFUND_NOT_FAILED", "retrying a successful refund", () =>
      retryFailedRefund({ refundId: refundF.id, actor: admin }),
    );
    console.log("retry       : FAILED gateway refund → ADMIN requeue → SUCCESS, offline path refused");

    /* ---------------------------------------------------------------- */
    /* G. Collection vs cancellation on one appointment.                 */
    /* ---------------------------------------------------------------- */
    const slotG = await createSlot(doctor.id, 2, 7);
    const pG = await createPatient("race");
    const apptG = await bookAppointment({ actor: pG, slotId: slotG.id, requestId: "day26-dod-race-book" });
    const paymentG = await paymentOf(apptG.id);
    if (!paymentG) fail("unreachable: race payment missing");

    const [collectResult, cancelResult] = await Promise.allSettled([
      collectOfflinePayment({ actor: staff, appointmentId: apptG.id, method: $Enums.PaymentMethod.CASH }),
      cancelAppointment({ actor: staff, appointmentId: apptG.id, reason: "Race close", requestId: "day26-dod-race-cancel" }),
    ]);
    expect(cancelResult.status === "fulfilled", `the concurrent cancellation should settle one way, got ${String(cancelResult.status)}`);
    const racePayment = await prisma.payment.findUnique({ where: { id: paymentG.id } });
    expect(racePayment?.status !== $Enums.PaymentStatus.PENDING, "a cancelled appointment never keeps a PENDING receivable");

    if (racePayment?.status === $Enums.PaymentStatus.PAID) {
      expect(collectResult.status === "fulfilled", "if collection won the lock, collection succeeded");
      const raceRefund = await refundOf(paymentG.id, $Enums.RefundKind.CLINIC_CAUSED);
      expect(raceRefund?.status === $Enums.RefundStatus.PENDING, "if collection won, the cancellation queues the hand-back");
      if (!raceRefund) fail("unreachable: race refund missing");
      await completeDeskHandBack({ refundId: raceRefund.id, method: $Enums.PaymentMethod.CASH, actor: staff });
    } else {
      expect(racePayment?.status === $Enums.PaymentStatus.VOIDED, "if cancellation won, the receivable is VOIDED");
      expect(collectResult.status === "rejected", "if cancellation won, the collection is refused");
      if (collectResult.status === "rejected") {
        expect(
          collectResult.reason instanceof AppError && collectResult.reason.code === "APPOINTMENT_NOT_PAYABLE",
          "the losing collection names the cancelled appointment",
        );
      }
      expect(await prisma.refund.count({ where: { paymentId: paymentG.id } }) === 0, "voided money has no refund");
    }
    console.log("race        : collect/cancel serialize; no PENDING receivable survives a cancellation");

    console.log("");
    console.log("Day 26 DoD passed — desk collection, voids, hand-backs, auto-cancel, retry and the collect/cancel race.");
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
