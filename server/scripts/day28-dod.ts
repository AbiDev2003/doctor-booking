import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { $Enums, PrismaClient } from "../src/generated/prisma/client.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { bookAppointment } from "../src/services/appointments/booking.service.js";
import { cancelAppointment, rejectAppointment } from "../src/services/appointments/appointmentTransition.service.js";
import { rescheduleAppointment } from "../src/services/reschedule.service.js";
import { collectOfflinePayment } from "../src/services/offlinePayment.service.js";
import { convertPayment } from "../src/services/paymentConvert.service.js";
import { completeDeskHandBack } from "../src/services/refund.service.js";
import { applyUnavailabilityCascade, autoCancelAfterSlotEnd } from "../src/services/appointmentCascade.service.js";
import { getClinicSettings } from "../src/services/clinic.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5000 }) });
const FIXTURE_EMAIL_PREFIX = "day28-";

function fail(message: string): never {
  throw new Error("FAIL: " + message);
}
function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

interface RunState {
  userIds: string[];
  patientIds: string[];
  doctorIds: string[];
  slotIds: string[];
}
interface PatientFixture extends ActorContext {
  email: string;
}

async function removeFixtures(state: RunState) {
  if (state.userIds.length === 0 && state.slotIds.length === 0) return;
  const appointments = await prisma.appointment.findMany({ where: { patientId: { in: state.patientIds } }, select: { id: true } });
  const appointmentIds = appointments.map((r: any) => r.id);
  const payments = await prisma.payment.findMany({ where: { patientId: { in: state.patientIds } }, select: { id: true } });
  const paymentIds = payments.map((r: any) => r.id);
  const refunds = await prisma.refund.findMany({ where: { paymentId: { in: paymentIds } }, select: { id: true } });
  const refundIds = refunds.map((r: any) => r.id);
  const targetIds = [...appointmentIds, ...paymentIds, ...refundIds];
  await prisma.notification.deleteMany({ where: { recipient: { startsWith: FIXTURE_EMAIL_PREFIX } } });
  await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.refund.deleteMany({ where: { id: { in: refundIds } } });
  await prisma.seatHold.deleteMany({ where: { patientId: { in: state.patientIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: state.userIds } }, { targetId: { in: targetIds } }] } as any });
  if (appointmentIds.length > 0) {
    await prisma.appointment.updateMany({ where: { id: { in: appointmentIds } }, data: { doctorUnavailabilityId: null } });
  }
  await prisma.doctorUnavailability.deleteMany({ where: { doctorId: { in: state.doctorIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await prisma.slot.deleteMany({ where: { id: { in: state.slotIds } } });
  if (state.patientIds.length > 0) await prisma.patientProfile.deleteMany({ where: { userId: { in: state.patientIds } } });
  if (state.doctorIds.length > 0) await prisma.doctorProfile.deleteMany({ where: { userId: { in: state.doctorIds } } });
  await prisma.user.deleteMany({ where: { id: { in: state.userIds } } });
}

async function purgeStaleFixtures() {
  const staleUsers = await prisma.user.findMany({ where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } }, select: { id: true, role: true } });
  if (staleUsers.length === 0) return 0;
  const userIds = staleUsers.map((r: any) => r.id);
  const doctorIds = staleUsers.filter((r: any) => r.role === $Enums.UserRole.DOCTOR).map((r: any) => r.id);
  const patientIds = staleUsers.filter((r: any) => r.role === $Enums.UserRole.PATIENT).map((r: any) => r.id);
  const staleSlots = await prisma.slot.findMany({ where: { doctorId: { in: doctorIds } }, select: { id: true } });
  await removeFixtures({ userIds, patientIds, doctorIds, slotIds: staleSlots.map((r: any) => r.id) });
  return staleUsers.length;
}

function timeValue(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}
async function countNotification(recipient: string, type: any) {
  return prisma.notification.count({ where: { recipient, type } });
}

async function main() {
  const clinic = await getClinicSettings();
  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log("purged      : " + purged + " stale fixture user(s)");
  const now = Date.now();
  const state: RunState = { userIds: [], patientIds: [], doctorIds: [], slotIds: [] };
  const suffix = process.pid + "-" + Date.now().toString().slice(-6);
  console.log("clinic      : " + clinic.name);
  try {
    const doctor = await prisma.user.create({
      data: {
        role: "DOCTOR" as any,
        fullName: "Day28 DoD doctor",
        email: FIXTURE_EMAIL_PREFIX + "doctor-" + suffix + "@example.test",
        emailVerifiedAt: new Date(),
        doctorProfile: { create: { verificationStatus: "VERIFIED" as any, consultationFee: 50000 } },
      },
      select: { id: true },
    });
    state.userIds.push(doctor.id);
    state.doctorIds.push(doctor.id);
    const staffActor: ActorContext = { id: doctor.id, role: $Enums.UserRole.STAFF, name: "Day28 DoD staff" };

    async function createSlot(maxPatients: number, offsetHours: number) {
      const startAt = new Date(now + (48 + offsetHours) * 3600000);
      const endAt = new Date(startAt.getTime() + 1800000);
      const localStart = utcToLocalDateTime(startAt, clinic.timezone);
      const localEnd = utcToLocalDateTime(endAt, clinic.timezone);
      const slot = await prisma.slot.create({
        data: {
          doctorId: doctor.id,
          slotDate: new Date(localStart.date + "T00:00:00.000Z"),
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
      const email = FIXTURE_EMAIL_PREFIX + label + "-" + suffix + "@example.test";
      const phone = "+919" + String(process.pid).padStart(5, "0") + String(Date.now()).slice(-5) + label.length;
      const user = await prisma.user.create({
        data: {
          role: "PATIENT" as any,
          fullName: "Day28 " + label,
          email,
          emailVerifiedAt: new Date(),
          passwordHash: "hash",
          patientProfile: { create: { phone } },
        },
        select: { id: true },
      });
      state.userIds.push(user.id);
      state.patientIds.push(user.id);
      return { id: user.id, role: $Enums.UserRole.PATIENT, name: "Day28 " + label, email };
    }

    const slotA = await createSlot(5, 1);
    const pA = await createPatient("payclinic");
    await bookAppointment({ actor: pA, slotId: slotA.id, ip: "203.0.113.28", requestId: "day28-dod-a" });
    expect((await countNotification(pA.email, $Enums.NotificationType.APPOINTMENT_BOOKED)) === 1, "A");
    console.log("A. Pay-at-clinic booking -> APPOINTMENT_BOOKED queued.");

    const slotB = await createSlot(5, 2);
    const pB = await createPatient("online");
    await prisma.seatHold.create({ data: { slotId: slotB.id, patientId: pB.id, paymentOrderId: "order_day28_" + suffix, expiresAt: new Date(Date.now() + 600000) } });
    await prisma.slot.update({ where: { id: slotB.id }, data: { heldCount: { increment: 1 } } });
    await prisma.payment.create({ data: { patientId: pB.id, amountPaise: 50000, currency: "INR", status: $Enums.PaymentStatus.PENDING, orderId: "order_day28_" + suffix } });
    await convertPayment({ actor: pB, orderId: "order_day28_" + suffix, gatewayPaymentId: "pay_day28_" + suffix, ip: "203.0.113.28", requestId: "day28-dod-b" });
    expect((await countNotification(pB.email, $Enums.NotificationType.APPOINTMENT_BOOKED)) === 1, "B1");
    expect((await countNotification(pB.email, $Enums.NotificationType.PAYMENT_SUCCESSFUL)) === 1, "B2");
    console.log("B. Online conversion -> APPOINTMENT_BOOKED + PAYMENT_SUCCESSFUL queued.");

    const slotC = await createSlot(5, 3);
    const pC = await createPatient("cancel");
    await bookAppointment({ actor: pC, slotId: slotC.id, ip: "203.0.113.28", requestId: "day28-dod-c" });
    const apptC = await prisma.appointment.findFirst({ where: { patientId: pC.id }, select: { id: true } });
    if (!apptC) fail("missing C");
    await cancelAppointment({ actor: pC, appointmentId: apptC.id, reason: null, requestId: "day28-dod-c-cancel" });
    expect((await countNotification(pC.email, $Enums.NotificationType.APPOINTMENT_CANCELLED)) === 1, "C");
    console.log("C. Cancel -> APPOINTMENT_CANCELLED queued.");

    const slotD = await createSlot(5, 4);
    const pD = await createPatient("reject");
    await bookAppointment({ actor: pD, slotId: slotD.id, ip: "203.0.113.28", requestId: "day28-dod-d" });
    const apptD = await prisma.appointment.findFirst({ where: { patientId: pD.id }, select: { id: true } });
    if (!apptD) fail("missing D");
    await rejectAppointment({ actor: staffActor, appointmentId: apptD.id, reason: "Not eligible", requestId: "day28-dod-d-reject" });
    expect((await countNotification(pD.email, $Enums.NotificationType.APPOINTMENT_REJECTED)) === 1, "D");
    console.log("D. Reject -> APPOINTMENT_REJECTED queued.");

    const slotE1 = await createSlot(5, 5);
    const slotE2 = await createSlot(5, 6);
    const pE = await createPatient("resched");
    await bookAppointment({ actor: pE, slotId: slotE1.id, ip: "203.0.113.28", requestId: "day28-dod-e" });
    const apptE = await prisma.appointment.findFirst({ where: { patientId: pE.id }, select: { id: true } });
    if (!apptE) fail("missing E");
    await rescheduleAppointment({ actor: pE, appointmentId: apptE.id, slotId: slotE2.id, reason: null, requestId: "day28-dod-e-resched" });
    expect((await countNotification(pE.email, $Enums.NotificationType.APPOINTMENT_RESCHEDULED)) === 1, "E");
    console.log("E. Reschedule -> APPOINTMENT_RESCHEDULED queued.");

    const slotF = await createSlot(5, 7);
    const pF = await createPatient("unavail");
    await bookAppointment({ actor: pF, slotId: slotF.id, ip: "203.0.113.28", requestId: "day28-dod-f" });
    const apptF = await prisma.appointment.findFirst({ where: { patientId: pF.id }, select: { id: true, slotId: true } });
    if (!apptF) fail("missing F");
    const slotFRow = await prisma.slot.findUnique({ where: { id: apptF.slotId }, select: { startAt: true, endAt: true } });
    if (!slotFRow) fail("missing slot F");
    const disruption = await prisma.doctorUnavailability.create({
      data: { doctorId: doctor.id, createdById: doctor.id, startAt: new Date(slotFRow.startAt.getTime() - 60000), endAt: new Date(slotFRow.endAt.getTime() + 60000), reason: "Day28 DoD unavailability" },
      select: { id: true },
    });
    await applyUnavailabilityCascade(prisma, { doctorId: doctor.id, window: { startAt: disruption.startAt, endAt: disruption.endAt }, disruptionId: disruption.id, reason: "Day28 DoD unavailability", actor: staffActor, ip: "203.0.113.28", requestId: "day28-dod-f-cascade" } as any);
    expect((await countNotification(pF.email, $Enums.NotificationType.DOCTOR_UNAVAILABLE)) === 1, "F");
    console.log("F. Doctor unavailability -> DOCTOR_UNAVAILABLE queued.");

    const slotG = await createSlot(1, 0);
    const pG = await createPatient("autocancel");
    await bookAppointment({ actor: pG, slotId: slotG.id, ip: "203.0.113.28", requestId: "day28-dod-g" });
    const apptG = await prisma.appointment.findFirst({ where: { patientId: pG.id }, select: { id: true, slotId: true } });
    if (!apptG) fail("missing G");
    const slotGRow = await prisma.slot.findUnique({ where: { id: apptG.slotId }, select: { startAt: true, endAt: true } });
    if (!slotGRow) fail("missing slot G");
    const duG = await prisma.doctorUnavailability.create({
      data: { doctorId: doctor.id, createdById: doctor.id, startAt: new Date(slotGRow.startAt.getTime() - 60000), endAt: new Date(slotGRow.endAt.getTime() + 60000), reason: "Day28 DoD auto-cancel" },
      select: { id: true },
    });
    await prisma.appointment.update({ where: { id: apptG.id }, data: { doctorUnavailabilityId: duG.id } });
    await prisma.appointment.updateMany({ where: { id: apptG.id }, data: { status: $Enums.AppointmentStatus.CONFIRMED } });
    await prisma.slot.update({ where: { id: slotG.id }, data: { endAt: new Date(Date.now() - 60000) } });
    await autoCancelAfterSlotEnd(new Date(Date.now() + 10000));
    expect((await countNotification(pG.email, $Enums.NotificationType.APPOINTMENT_AUTO_CANCELLED)) === 1, "G");
    console.log("G. Auto-cancel after slot end -> APPOINTMENT_AUTO_CANCELLED queued.");

    const slotH = await createSlot(5, 8);
    const pH = await createPatient("collect");
    await bookAppointment({ actor: pH, slotId: slotH.id, ip: "203.0.113.28", requestId: "day28-dod-h" });
    const apptH = await prisma.appointment.findFirst({ where: { patientId: pH.id }, select: { id: true } });
    if (!apptH) fail("missing H");
    await collectOfflinePayment({ actor: staffActor, appointmentId: apptH.id, method: $Enums.PaymentMethod.CASH, ip: "203.0.113.28", requestId: "day28-dod-h-collect" });
    expect((await countNotification(pH.email, $Enums.NotificationType.PAYMENT_SUCCESSFUL)) === 1, "H");
    console.log("H. Offline collect -> PAYMENT_SUCCESSFUL queued.");

    const slotI = await createSlot(5, 9);
    const pI = await createPatient("refund");
    await bookAppointment({ actor: pI, slotId: slotI.id, ip: "203.0.113.28", requestId: "day28-dod-i" });
    const apptI = await prisma.appointment.findFirst({ where: { patientId: pI.id }, select: { id: true } });
    if (!apptI) fail("missing I");
    await collectOfflinePayment({ actor: staffActor, appointmentId: apptI.id, method: $Enums.PaymentMethod.CASH, ip: "203.0.113.28", requestId: "day28-dod-i-collect" });
    await cancelAppointment({ actor: staffActor, appointmentId: apptI.id, reason: "Clinic cancelled", requestId: "day28-dod-i-cancel" });
    const paymentI = await prisma.payment.findFirst({ where: { appointmentId: apptI.id }, select: { id: true, status: true, amountPaise: true } });
    if (!paymentI) fail("missing payment I");
    const refundI = await prisma.refund.findFirst({ where: { paymentId: paymentI.id }, select: { id: true, status: true } });
    if (!refundI) fail("missing refund I");
    await completeDeskHandBack({ actor: staffActor, refundId: refundI.id, method: $Enums.PaymentMethod.CASH, ip: "203.0.113.28", requestId: "day28-dod-i-handback" });
    expect((await countNotification(pI.email, $Enums.NotificationType.REFUND_COMPLETED)) === 1, "I");
    console.log("I. Refund completion (desk hand-back) -> REFUND_COMPLETED queued.");

    console.log("\nDay 28 DoD passed.");
  } finally {
    await removeFixtures(state);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
