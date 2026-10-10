// Day 18 DoD against the real local database:
//
//   npx tsx scripts/day18-dod.ts
//
// Proves, through the actual Day 18 services (not the pure guard alone), the
// two properties plan.md §12 pins on DoctorUnavailability:
//
//   1. MARK + CLOSE + CASCADE. Creating a disruption hides the overlapping
//      slot from the public read model (decision 1: read-hide, no slot
//      mutation), flags the overlapping CONFIRMED booking clinic-caused and
//      queues it a DOCTOR_UNAVAILABLE notification — all in ONE transaction.
//   2. THE [T] RULE AT BOTH INSTANTS. The COMPLETED booking on the same slot
//      is neither marked nor auto-cancelled: attendance is never overwritten.
//   3. AUTO-CANCEL AT SLOT END + THE SEAM. `autoCancelAfterSlotEnd` (the §12
//      job body, run directly — the interval runner is Day 29) flips the
//      marked booking to CANCELLED with a system actor, frees its seat,
//      writes its history + APPOINTMENT_AUTO_CANCELLED notification, and the
//      refund/notification seams are present. Only the marked CONFIRMED
//      booking is touched.
//   4. REMOVAL IS BLOCKED WHILE REFERENCED. DELETE on a disruption any
//      appointment still references answers 409 UNAVAILABILITY_IN_USE
//      (decision 3) — a nulled marker would erase the §17 clinic-caused fact.
//   5. THE CREATE WALLS: a missing reason is refused (422 REASON_REQUIRED),
//      and an end-before-start window is refused (422 INVALID_WINDOW).
//
// Clean-up: every synthetic row this run creates is removed in a `finally`, and
// the slot's bookedCount is restored, so the database ends as it started. The
// §20 AuditLog + DoctorHistory rows the services wrote are LEFT as residue
// (append-only tables; a re-seed resets everything regardless) — the same
// bargain day16-dod.ts struck.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { enumerateDates, weekdayOfDate } from "../src/lib/slotPlan.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { AppError } from "../src/lib/appError.js";
import { listDoctorAvailability } from "../src/services/availability.service.js";
import { autoCancelAfterSlotEnd } from "../src/services/appointmentCascade.service.js";
import {
  createDoctorUnavailability,
  removeDoctorUnavailability,
} from "../src/services/unavailability.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const DOCTOR_NAME_MARKER = "DoD synthetic doctor";
const UNAVAILABILITY_REASON = "DoD day18 unavailability";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/** Expects `fn` to reject with an AppError carrying `code`; returns the message. */
async function expectRejection(code: string, what: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof AppError)) {
      console.error(`FAIL: ${what} threw a non-AppError:`, err);
      process.exit(1);
    }
    if (err.code !== code) {
      console.error(`FAIL: expected ${code} for ${what}, got ${err.code}: ${err.message}`);
      process.exit(1);
    }
    return err.message;
  }
  console.error(`FAIL: expected ${code} for ${what}, but the call succeeded.`);
  process.exit(1);
}

interface RunState {
  slotId: string;
  originalBookedCount: number;
  unavailabilityIds: string[];
  appointmentIds: string[];
  createdUnavailabilityId?: string;
  confirmedAppointmentId?: string;
  completedAppointmentId?: string;
}

async function cleanup(state: RunState): Promise<void> {
  if (state.appointmentIds.length > 0) {
    await prisma.notification.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.seatHold.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.appointment.deleteMany({ where: { id: { in: state.appointmentIds } } });
  }
  if (state.unavailabilityIds.length > 0) {
    await prisma.doctorUnavailability.deleteMany({ where: { id: { in: state.unavailabilityIds } } });
  }
  await prisma.slot.update({
    where: { id: state.slotId },
    data: { bookedCount: state.originalBookedCount },
  });
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findUnique({ where: { id: "0c000000-0000-4000-8000-000000000001" } });
  if (!clinic) fail("No clinic row. Run the seed first (npm run db:seed).");

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  if (!admin) fail("No ADMIN user. Run the seed first (npm run db:seed).");
  const actor: ActorContext = { id: admin.id, role: "ADMIN", name: "day18-dod" };

  // Two patients: patientA holds the CONFIRMED booking the cascade must mark,
  // patientB the COMPLETED one the [T] rule must leave alone. The fixed seed
  // ids are safe because patients are upserted on them; a different seed is
  // just a different data set and the assertions read the rows back.
  const [patientA, patientB] = await prisma.user.findMany({
    where: { role: "PATIENT" },
    orderBy: { id: "asc" },
    take: 2,
    select: { id: true, fullName: true, email: true },
  });
  if (!patientA || !patientB) fail("Need at least two PATIENTs. Run the seed first (npm run db:seed).");

  const doctor = await prisma.user.findFirst({
    where: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    select: { id: true, fullName: true },
  });
  if (!doctor) fail("No VERIFIED doctor. Run the seed first (npm run db:seed).");

  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;

  // A FUTURE planned day (never today: today's windows may already have
  // elapsed). The slot we drive the disruption over is real and generated.
  const windows = await prisma.schedule.findMany({
    where: { doctorId: doctor.id },
    select: { weekday: true },
  });
  if (windows.length === 0) fail("The doctor has no schedule windows. Re-seed and retry.");
  const plannedDate = enumerateDates(today, clinic.bookingHorizonDays).find(
    (date) => date !== today && windows.some((w) => w.weekday === weekdayOfDate(date)),
  );
  if (!plannedDate) fail("No future planned slot date within the horizon for the doctor.");

  const baseline = await listDoctorAvailability(doctor.id, plannedDate);
  if (baseline.length === 0) fail(`Baseline listed no bookable slots on ${plannedDate} (expected at least one).`);
  const slotId = baseline[0]!.slotId;

  const slot = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!slot) fail("The listed slot vanished before it could be inspected.");

  // Deliberately start the run clean even after an aborted previous attempt:
  // the outstanding unavailability row (reason from this script) cannot be
  // deleted until its appointments are, and the appointments cannot be
  // deleted until their notifications/histories are.
  await cleanup({
    slotId,
    originalBookedCount: slot.bookedCount,
    unavailabilityIds: (
      await prisma.doctorUnavailability.findMany({
        where: { doctorId: doctor.id, reason: UNAVAILABILITY_REASON },
        select: { id: true },
      })
    ).map((row) => row.id),
    appointmentIds: (
      await prisma.appointment.findMany({
        where: { doctorName: DOCTOR_NAME_MARKER, slotId },
        select: { id: true },
      })
    ).map((row) => row.id),
  });

  const state: RunState = {
    slotId,
    originalBookedCount: slot.bookedCount,
    unavailabilityIds: [],
    appointmentIds: [],
  };

  console.log(`clinic        : ${clinic.name} (${clinic.timezone}, horizon ${clinic.bookingHorizonDays}d)`);
  console.log(`doctor        : ${doctor.fullName} (${doctor.id})`);
  console.log(`target slot   : ${plannedDate} ${slot.startTime.toISOString().slice(11, 16)}–${slot.endTime.toISOString().slice(11, 16)}`);
  console.log(`patients      : ${patientA.fullName} (CONFIRMED) + ${patientB.fullName} (COMPLETED)`);

  try {
    /* ---------------------------------------------------------------- */
    /* Synthetic bookings on the real slot. One seat is "booked".        */
    /* ---------------------------------------------------------------- */

    const confirmed = await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patientA.id,
        slotId,
        status: "CONFIRMED",
        doctorName: DOCTOR_NAME_MARKER,
        feeAmount: clinic.defaultConsultationFee,
      },
    });
    state.appointmentIds.push(confirmed.id);
    state.confirmedAppointmentId = confirmed.id;

    const completed = await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patientB.id,
        slotId,
        status: "COMPLETED",
        doctorName: DOCTOR_NAME_MARKER,
        feeAmount: clinic.defaultConsultationFee,
      },
    });
    state.appointmentIds.push(completed.id);
    state.completedAppointmentId = completed.id;

    await prisma.slot.update({ where: { id: slotId }, data: { bookedCount: 1 } });

    /* ---------------------------------------------------------------- */
    /* 5 (first). The create walls — nothing mutated.                    */
    /* ---------------------------------------------------------------- */

    await expectRejection("REASON_REQUIRED", "creating a disruption without a reason", () =>
      createDoctorUnavailability({
        actor,
        doctorId: doctor.id,
        date: plannedDate,
        startTime: slot.startTime.toISOString().slice(11, 16),
        endTime: slot.endTime.toISOString().slice(11, 16),
        reason: "   ",
      }),
    );
    await expectRejection("INVALID_WINDOW", "creating a window that ends before it starts", () =>
      createDoctorUnavailability({
        actor,
        doctorId: doctor.id,
        date: plannedDate,
        startTime: "10:00",
        endTime: "09:00",
        reason: "DoD",
      }),
    );
    console.log("[5] create walls   : missing reason refused (422 REASON_REQUIRED) | inverted window refused (422 INVALID_WINDOW)");

    /* ---------------------------------------------------------------- */
    /* 1. Mark + close + cascade, atomically.                            */
    /* ---------------------------------------------------------------- */

    const created = await createDoctorUnavailability({
      actor,
      doctorId: doctor.id,
      date: plannedDate,
      startTime: slot.startTime.toISOString().slice(11, 16),
      endTime: slot.endTime.toISOString().slice(11, 16),
      reason: UNAVAILABILITY_REASON,
    });
    state.unavailabilityIds.push(created.unavailability.id);
    state.createdUnavailabilityId = created.unavailability.id;

    if (created.affectedCount !== 1) {
      fail(`Expected exactly 1 affected appointment, got ${created.affectedCount}.`);
    }

    const marked = await prisma.appointment.findUnique({
      where: { id: confirmed.id },
      select: { doctorUnavailabilityId: true, status: true },
    });
    if (marked?.doctorUnavailabilityId !== created.unavailability.id) {
      fail("The CONFIRMED booking was not stamped with the disruption marker.");
    }

    const untouched = await prisma.appointment.findUnique({
      where: { id: completed.id },
      select: { doctorUnavailabilityId: true, status: true },
    });
    if (untouched?.doctorUnavailabilityId !== null) {
      fail("The COMPLETED booking was marked — attendance must never be overwritten ([T]).");
    }

    const notification = await prisma.notification.findFirst({
      where: { appointmentId: confirmed.id, type: "DOCTOR_UNAVAILABLE" },
      select: { recipient: true, status: true },
    });
    if (!notification || notification.recipient !== patientA.email) {
      fail("No DOCTOR_UNAVAILABLE notification row was queued for the affected patient.");
    }

    // Decision 1: closing the slot is a READ-side fact — the disruption hides
    // it, no slot row changes.
    const listed = await listDoctorAvailability(doctor.id, plannedDate);
    if (listed.some((available) => available.slotId === slotId)) {
      fail("The overlapped slot was still listed as bookable after the disruption.");
    }
    console.log(`[1] mark+close     : slot hidden | CONFIRMED stamped + notified (${patientA.fullName}) | COMPLETED untouched`);

    /* ---------------------------------------------------------------- */
    /* 3. Auto-cancel at slot end (job body run directly; the [T] rule   */
    /*    holds at the cancel instant too).                              */
    /* ---------------------------------------------------------------- */

    const jobNow = new Date(slot.endAt.getTime() + 60_000);
    const cancelled = await autoCancelAfterSlotEnd(jobNow);
    if (!cancelled.cancelledAppointmentIds.includes(confirmed.id)) {
      fail("autoCancelAfterSlotEnd did not cancel the marked booking.");
    }

    const afterCancel = await prisma.appointment.findUnique({
      where: { id: confirmed.id },
      select: { status: true, doctorUnavailabilityId: true },
    });
    if (afterCancel?.status !== "CANCELLED") fail("The marked booking was not cancelled.");
    if (afterCancel?.doctorUnavailabilityId === null) fail("The cancelled booking lost its clinic-caused marker.");

    const seatFreed = await prisma.slot.findUnique({ where: { id: slotId }, select: { bookedCount: true } });
    if (seatFreed?.bookedCount !== 0) fail("The cancelled booking's seat was not freed (§8.1 bookedCount).");

    const history = await prisma.appointmentHistory.findFirst({
      where: { appointmentId: confirmed.id, eventType: "CANCELLED" },
      select: { fromStatus: true, toStatus: true, actorName: true },
    });
    if (!history || history.actorName !== "system" || history.fromStatus !== "CONFIRMED" || history.toStatus !== "CANCELLED") {
      fail("No system-actored CANCELLED appointment-history event was written.");
    }

    const autoNotification = await prisma.notification.findFirst({
      where: { appointmentId: confirmed.id, type: "APPOINTMENT_AUTO_CANCELLED" },
    });
    if (!autoNotification) fail("No APPOINTMENT_AUTO_CANCELLED notification was queued.");

    const completedAfter = await prisma.appointment.findUnique({
      where: { id: completed.id },
      select: { status: true },
    });
    if (completedAfter?.status !== "COMPLETED") fail("The COMPLETED booking was changed by the auto-cancel job ([T]).");
    console.log("[3] auto-cancel   : CONFIRMED → CANCELLED (system), seat freed, history + notification written; COMPLETED untouched");

    /* ---------------------------------------------------------------- */
    /* 4. Removal is blocked while an appointment references a marker.   */
    /* ---------------------------------------------------------------- */

    const removeError = await expectRejection("UNAVAILABILITY_IN_USE", "removing a referenced disruption", () =>
      removeDoctorUnavailability({
        actor,
        unavailabilityId: created.unavailability.id,
        reason: "DoD",
      }),
    );
    console.log(`[4] removal wall   : referenced disruption refused (${removeError})`);
  } finally {
    await cleanup(state);
  }

  console.log("DoD met: marking a doctor unavailable closes the overlapped slot and cascades the");
  console.log("   bookable seats cleanly — CONFIRMED bookings are flagged, notified and auto-cancelled");
  console.log("   at slot end with a system record, attendance is never overwritten, and a referenced");
  console.log("   disruption cannot be deleted.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });