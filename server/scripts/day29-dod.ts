import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { $Enums, PrismaClient } from "../src/generated/prisma/client.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { bookAppointment } from "../src/services/booking.service.js";
import { getClinicSettings } from "../src/services/clinic.service.js";
import { sendAppointmentReminders } from "../src/jobs/reminders.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5000 }) });
const FIXTURE_EMAIL_PREFIX = "day29-";

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
  await prisma.doctorUnavailability.deleteMany({ where: { doctorId: { in: state.doctorIds } } });
  if (appointmentIds.length > 0) {
    await prisma.appointment.updateMany({ where: { id: { in: appointmentIds } }, data: { doctorUnavailabilityId: null } });
  }
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

async function main() {
  const clinic = await getClinicSettings();
  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log("purged      : " + purged + " stale fixture user(s)");
  const now = new Date();
  const state: RunState = { userIds: [], patientIds: [], doctorIds: [], slotIds: [] };
  const suffix = process.pid + "-" + Date.now().toString().slice(-6);
  console.log("clinic      : " + clinic.name);
  try {
    const doctor = await prisma.user.create({
      data: {
        role: "DOCTOR" as any,
        fullName: "Day29 DoD doctor",
        email: FIXTURE_EMAIL_PREFIX + "doctor-" + suffix + "@example.test",
        emailVerifiedAt: new Date(),
        doctorProfile: { create: { verificationStatus: "VERIFIED" as any, consultationFee: 50000 } },
      },
      select: { id: true },
    });
    state.userIds.push(doctor.id);
    state.doctorIds.push(doctor.id);

    async function createPatient(label: string): Promise<PatientFixture> {
      const email = FIXTURE_EMAIL_PREFIX + label + "-" + suffix + "@example.test";
      const phone = "+919" + String(process.pid).padStart(5, "0") + String(Date.now()).slice(-5) + label.length;
      const user = await prisma.user.create({
        data: {
          role: "PATIENT" as any,
          fullName: "Day29 " + label,
          email,
          emailVerifiedAt: new Date(),
          passwordHash: "hash",
          patientProfile: { create: { phone } },
        },
        select: { id: true },
      });
      state.userIds.push(user.id);
      state.patientIds.push(user.id);
      return { id: user.id, role: $Enums.UserRole.PATIENT, name: "Day29 " + label, email };
    }

    const lead = clinic.reminderLeadMinutes ?? 120;
    const startAt = new Date(now.getTime() + lead * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);
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
        maxPatients: 5,
      },
      select: { id: true, startAt: true },
    });
    state.slotIds.push(slot.id);

    const p = await createPatient("remind");
    await bookAppointment({ actor: p, slotId: slot.id, ip: "203.0.113.29", requestId: "day29-dod-book" });

    await sendAppointmentReminders(now);
    const count1 = await prisma.notification.count({
      where: { recipient: p.email, type: $Enums.NotificationType.APPOINTMENT_REMINDER },
    });
    expect(count1 === 1, "reminder created once");

    await sendAppointmentReminders(now);
    const count2 = await prisma.notification.count({
      where: { recipient: p.email, type: $Enums.NotificationType.APPOINTMENT_REMINDER },
    });
    expect(count2 === 1, "reminder not duplicated on re-run");

    console.log("Day 29 DoD passed — reminder fires once at T-reminderLeadMinutes.");
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
