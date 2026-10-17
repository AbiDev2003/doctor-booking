// Day 21 DoD against the real local database:
//
//   npx tsx scripts/day21-dod.ts
//
// Proves the two halves plan.md §13/§13.1 pins on status transitions, through
// the actual Day 21 services (not the pure guard alone):
//
//   1. THE MATRIX AND ITS WALLS. An illegal pair (COMPLETED straight from
//      CONFIRMED) is refused 409 INVALID_TRANSITION; ARRIVED before the slot's
//      start is 409 SLOT_NOT_STARTED; NO_SHOW before its end is 409
//      SLOT_NOT_ENDED; a doctor cannot change attendance (403 FORBIDDEN); and a
//      terminal state accepts nothing.
//   2. THE MANDATORY REASON. Rejecting, and a staff cancellation, without a
//      reason are refused 422 REASON_REQUIRED.
//   3. THE CHECK-IN FLOW. CONFIRMED → ARRIVED → COMPLETED, each writing its
//      AppointmentHistory event and its §20 audit row, with the seat KEPT
//      (COMPLETED/NO_SHOW do not release a seat, §13.1).
//   4. NO_SHOW keeps its seat, too.
//   5. REJECT frees the seat and queues the §18 APPOINTMENT_REJECTED email row.
//   6. PATIENT CANCEL respects the §8.5 cutoff: before it, success (seat freed,
//      APPOINTMENT_CANCELLED queued); at/after it, 409 CUTOFF_REACHED with the
//      booking untouched; and a clinic-caused booking is waived past the cutoff.
//   7. STAFF CANCEL of an ARRIVED booking frees the seat, and the §12 auto-cancel
//      job leaves the already-cancelled row alone (it acts only on CONFIRMED).
//   8. THE RACE. Two concurrent NO_SHOW attempts on one booking produce exactly
//      one NO_SHOW and one 409 — one history row, never two.
//
// Clean-up: this script creates its OWN patients and its own synthetic slots (on
// dates years outside the booking horizon, so no generated slot can clash), then
// removes every row it created in a `finally`, so the database ends as it
// started. The §20 AuditLog rows the real ADMIN actor wrote are LEFT as residue
// (append-only; a re-seed resets everything) — the same bargain day16/18/19/20
// struck. The audit rows a synthetic PATIENT authored (their self-cancellations)
// are the one exception: the patient cannot be deleted while its FK holds, so
// those rows go with it.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { $Enums, PrismaClient } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { autoCancelAfterSlotEnd } from "../src/services/appointmentCascade.service.js";
import {
  arriveAppointment,
  cancelAppointment,
  completeAppointment,
  markNoShow,
  rejectAppointment,
} from "../src/services/appointmentTransition.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const DOCTOR_NAME_MARKER = "Day21 DoD synthetic";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

/** Expects `fn` to reject with an AppError carrying `code`; returns the error. */
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

const MINUTE = 60_000;

interface RunState {
  patientIds: string[];
  slotIds: string[];
  appointmentIds: string[];
  unavailabilityIds: string[];
}

async function cleanup(state: RunState): Promise<void> {
  if (state.appointmentIds.length > 0) {
    await prisma.notification.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.payment.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.seatHold.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.appointment.deleteMany({ where: { id: { in: state.appointmentIds } } });
  }
  if (state.slotIds.length > 0) {
    await prisma.slot.deleteMany({ where: { id: { in: state.slotIds } } });
  }
  if (state.unavailabilityIds.length > 0) {
    await prisma.doctorUnavailability.deleteMany({ where: { id: { in: state.unavailabilityIds } } });
  }
  if (state.patientIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: state.patientIds } } });
    await prisma.user.deleteMany({ where: { id: { in: state.patientIds } } });
  }
}

/**
 * Removes fixtures a previous crashed run left behind (identified by the
 * `day21-` email prefix no real account uses) so their synthetic slots do not
 * linger on the 2000-01-* dates this script reuses.
 */
async function purgeStaleFixtures(): Promise<number> {
  const stale = await prisma.user.findMany({ where: { email: { startsWith: "day21-" } }, select: { id: true } });
  const patientIds = stale.map((row) => row.id);
  if (patientIds.length === 0) return 0;

  const staleAppointments = await prisma.appointment.findMany({
    where: { patientId: { in: patientIds } },
    select: { id: true, slotId: true },
  });
  const appointmentIds = staleAppointments.map((row) => row.id);
  const slotIds = [...new Set(staleAppointments.map((row) => row.slotId))];

  await prisma.notification.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.payment.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.seatHold.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await prisma.slot.deleteMany({ where: { id: { in: slotIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: patientIds } } });
  return patientIds.length;
}

/** Creates `count` verified synthetic patients, so nothing touches a real one. */
async function createPatients(count: number): Promise<ActorContext[]> {
  const actors: ActorContext[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = await prisma.user.create({
      data: {
        role: "PATIENT",
        fullName: `Day21 patient ${i}`,
        email: `day21-patient-${i}-${process.pid}@example.test`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true, fullName: true },
    });
    actors.push({ id: user.id, role: "PATIENT", name: user.fullName });
  }
  return actors;
}

/**
 * A synthetic slot on a 2000-01-* date — years outside the booking horizon, so
 * it can never collide with a generated one. The transition service reads only
 * `startAt`/`endAt`, which the caller positions relative to real time.
 */
let slotSeq = 0;
async function createSlot(doctorId: string, startAt: Date, endAt: Date): Promise<string> {
  slotSeq += 1;
  const slot = await prisma.slot.create({
    data: {
      doctorId,
      slotDate: new Date(Date.UTC(2000, 0, slotSeq)),
      startTime: new Date(Date.UTC(1970, 0, 1, startAt.getUTCHours(), startAt.getUTCMinutes(), 0)),
      endTime: new Date(Date.UTC(1970, 0, 1, endAt.getUTCHours(), endAt.getUTCMinutes(), 0)),
      startAt,
      endAt,
      maxPatients: 5,
      bookedCount: 0,
      heldCount: 0,
    },
    select: { id: true },
  });
  return slot.id;
}

/** A booking fixture: the appointment plus the seat its status consumes. */
async function createAppointment(
  doctorId: string,
  slotId: string,
  patientId: string,
  status: "CONFIRMED" | "ARRIVED",
  feeAmount: number,
  doctorUnavailabilityId: string | null = null,
): Promise<string> {
  const appointment = await prisma.appointment.create({
    data: { doctorId, patientId, slotId, status, doctorName: DOCTOR_NAME_MARKER, feeAmount, doctorUnavailabilityId },
    select: { id: true },
  });
  await prisma.slot.update({ where: { id: slotId }, data: { bookedCount: { increment: 1 } } });
  return appointment.id;
}

async function bookedCount(slotId: string): Promise<number> {
  const slot = await prisma.slot.findUniqueOrThrow({ where: { id: slotId }, select: { bookedCount: true } });
  return slot.bookedCount;
}

async function historyCount(appointmentId: string, eventType: $Enums.AppointmentEventType): Promise<number> {
  return prisma.appointmentHistory.count({ where: { appointmentId, eventType } });
}

async function auditCount(action: string, appointmentId: string): Promise<number> {
  return prisma.auditLog.count({ where: { action, targetType: "appointment", targetId: appointmentId } });
}

async function main(): Promise<void> {
  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log(`purged      : ${purged} stale fixture patient(s) from a crashed run`);

  const clinic = await prisma.clinic.findFirst();
  if (!clinic) fail("No clinic row. Run the seed first (npm run db:seed).");

  const doctor = await prisma.user.findFirst({
    where: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    select: { id: true, fullName: true },
  });
  if (!doctor) fail("No VERIFIED doctor. Run the seed first (npm run db:seed).");

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, fullName: true } });
  if (!admin) fail("No ADMIN user. Run the seed first (npm run db:seed).");
  const actor: ActorContext = { id: admin.id, role: "ADMIN", name: admin.fullName };

  const state: RunState = { patientIds: [], slotIds: [], appointmentIds: [], unavailabilityIds: [] };
  const fee = clinic.defaultConsultationFee;
  const now = Date.now();

  console.log(`clinic      : ${clinic.name} (${clinic.timezone}, cutoff ${clinic.cancelCutoffMinutes}m)`);
  console.log(`doctor      : ${doctor.fullName}`);
  console.log(`actor       : ${admin.fullName} (ADMIN)`);

  try {
    const patients = await createPatients(2);
    state.patientIds = patients.map((patient) => patient.id);
    const [patientA, patientB] = patients;
    if (!patientA || !patientB) fail("scenario 0: the synthetic patients were not created");

    /* ---------------------------------------------------------------- */
    /* Fixtures: one slot per timeline shape the walls need.            */
    /* ---------------------------------------------------------------- */
    const futureSlot = await createSlot(doctor.id, new Date(now + 180 * MINUTE), new Date(now + 240 * MINUTE));
    const startedSlot = await createSlot(doctor.id, new Date(now - 10 * MINUTE), new Date(now + 50 * MINUTE));
    const endedSlot = await createSlot(doctor.id, new Date(now - 60 * MINUTE), new Date(now - 10 * MINUTE));
    const nearSlot = await createSlot(doctor.id, new Date(now + 30 * MINUTE), new Date(now + 90 * MINUTE));
    state.slotIds = [futureSlot, startedSlot, endedSlot, nearSlot];

    /* ---------------------------------------------------------------- */
    /* 1 + 2. The matrix, the clock walls and the reason rule.          */
    /* ---------------------------------------------------------------- */
    const futureAppt = await createAppointment(doctor.id, futureSlot, patientA.id, "CONFIRMED", fee);
    const startedAppt = await createAppointment(doctor.id, startedSlot, patientA.id, "CONFIRMED", fee);
    const endedAppt = await createAppointment(doctor.id, endedSlot, patientA.id, "CONFIRMED", fee);
    state.appointmentIds.push(futureAppt, startedAppt, endedAppt);

    await expectRejection("INVALID_TRANSITION", "COMPLETED straight from CONFIRMED", () =>
      completeAppointment({ actor, appointmentId: futureAppt }),
    );
    await expectRejection("SLOT_NOT_STARTED", "checking in before the slot starts", () =>
      arriveAppointment({ actor, appointmentId: futureAppt }),
    );
    await expectRejection("SLOT_NOT_ENDED", "marking a no-show before the slot ends", () =>
      markNoShow({ actor, appointmentId: startedAppt }),
    );
    await expectRejection("REASON_REQUIRED", "rejecting without a reason", () =>
      rejectAppointment({ actor, appointmentId: futureAppt, reason: "   " }),
    );
    await expectRejection("REASON_REQUIRED", "a staff cancellation without a reason", () =>
      cancelAppointment({ actor, appointmentId: futureAppt, reason: "  " }),
    );
    await expectRejection("FORBIDDEN", "a patient changing attendance", () =>
      arriveAppointment({ actor: patientA, appointmentId: futureAppt }),
    );
    await expectRejection("FORBIDDEN", "a patient cancelling another patient's booking", () =>
      cancelAppointment({ actor: patientB, appointmentId: futureAppt }),
    );
    console.log("[1] matrix + walls : INVALID_TRANSITION | SLOT_NOT_STARTED | SLOT_NOT_ENDED | FORBIDDEN all refused");
    console.log("[2] reason rule    : reject + staff-cancel without a reason refused 422 REASON_REQUIRED");

    /* ---------------------------------------------------------------- */
    /* 3. The check-in flow: CONFIRMED → ARRIVED → COMPLETED.           */
    /* ---------------------------------------------------------------- */
    const arrived = await arriveAppointment({ actor, appointmentId: startedAppt, requestId: "day21-dod" });
    expect(arrived.status === "ARRIVED", `check-in left the status ${arrived.status}, expected ARRIVED`);

    const completed = await completeAppointment({ actor, appointmentId: startedAppt, requestId: "day21-dod" });
    expect(completed.status === "COMPLETED", `completion left the status ${completed.status}, expected COMPLETED`);
    expect(await bookedCount(startedSlot) === 1, "COMPLETED released the seat — §13.1 keeps it");

    expect(await historyCount(startedAppt, "ARRIVED") === 1, "no ARRIVED history event");
    expect(await historyCount(startedAppt, "COMPLETED") === 1, "no COMPLETED history event");
    expect(await auditCount("APPOINTMENT_ARRIVED", startedAppt) === 1, "no APPOINTMENT_ARRIVED audit row");
    expect(await auditCount("APPOINTMENT_COMPLETED", startedAppt) === 1, "no APPOINTMENT_COMPLETED audit row");

    await expectRejection("INVALID_TRANSITION", "any transition out of COMPLETED", () =>
      arriveAppointment({ actor, appointmentId: startedAppt }),
    );
    console.log("[3] check-in flow  : CONFIRMED → ARRIVED → COMPLETED | seat kept | history + audit written | terminal refused");

    /* ---------------------------------------------------------------- */
    /* 4. NO_SHOW keeps its seat.                                        */
    /* ---------------------------------------------------------------- */
    const noShow = await markNoShow({ actor, appointmentId: endedAppt, requestId: "day21-dod" });
    expect(noShow.status === "NO_SHOW", `no-show left the status ${noShow.status}, expected NO_SHOW`);
    expect(await bookedCount(endedSlot) === 1, "NO_SHOW released the seat — §13.1 keeps it");
    expect(await historyCount(endedAppt, "NO_SHOW") === 1, "no NO_SHOW history event");
    expect(await auditCount("APPOINTMENT_NO_SHOW", endedAppt) === 1, "no APPOINTMENT_NO_SHOW audit row");
    console.log("[4] no-show        : CONFIRMED → NO_SHOW | seat kept | history + audit written");

    /* ---------------------------------------------------------------- */
    /* 5. REJECT frees the seat and queues the §18 email row.           */
    /* ---------------------------------------------------------------- */
    const rejectSlot = await createSlot(doctor.id, new Date(now + 200 * MINUTE), new Date(now + 260 * MINUTE));
    state.slotIds.push(rejectSlot);
    const rejectAppt = await createAppointment(doctor.id, rejectSlot, patientB.id, "CONFIRMED", fee);
    state.appointmentIds.push(rejectAppt);

    const rejected = await rejectAppointment({
      actor,
      appointmentId: rejectAppt,
      reason: "Suspected duplicate booking",
      requestId: "day21-dod",
    });
    expect(rejected.status === "REJECTED", `reject left the status ${rejected.status}, expected REJECTED`);
    expect(await bookedCount(rejectSlot) === 0, "REJECTED did not free the seat");
    const rejectNotification = await prisma.notification.count({
      where: { appointmentId: rejectAppt, type: "APPOINTMENT_REJECTED" },
    });
    expect(rejectNotification === 1, "no APPOINTMENT_REJECTED notification queued");
    expect(await auditCount("APPOINTMENT_REJECTED", rejectAppt) === 1, "no APPOINTMENT_REJECTED audit row");
    console.log("[5] reject         : CONFIRMED → REJECTED | seat freed | history + notification + audit");

    /* ---------------------------------------------------------------- */
    /* 6. Patient cancel and the §8.5 cutoff.                            */
    /* ---------------------------------------------------------------- */
    const cancelSlot = await createSlot(doctor.id, new Date(now + 180 * MINUTE), new Date(now + 240 * MINUTE));
    state.slotIds.push(cancelSlot);
    const cancelAppt = await createAppointment(doctor.id, cancelSlot, patientA.id, "CONFIRMED", fee);
    state.appointmentIds.push(cancelAppt);

    const cancelled = await cancelAppointment({
      actor: patientA,
      appointmentId: cancelAppt,
      requestId: "day21-dod",
    });
    expect(cancelled.status === "CANCELLED", `patient cancel left the status ${cancelled.status}`);
    expect(await bookedCount(cancelSlot) === 0, "patient cancel did not free the seat");
    const cancelNotification = await prisma.notification.count({
      where: { appointmentId: cancelAppt, type: "APPOINTMENT_CANCELLED" },
    });
    expect(cancelNotification === 1, "no APPOINTMENT_CANCELLED notification queued");

    // Inside the cutoff window → refused, booking untouched.
    const nearAppt = await createAppointment(doctor.id, nearSlot, patientA.id, "CONFIRMED", fee);
    state.appointmentIds.push(nearAppt);
    await expectRejection("CUTOFF_REACHED", "cancelling inside the cutoff window", () =>
      cancelAppointment({ actor: patientA, appointmentId: nearAppt }),
    );
    const nearStatus = await prisma.appointment.findUniqueOrThrow({ where: { id: nearAppt }, select: { status: true } });
    expect(nearStatus.status === "CONFIRMED", "a refused cancellation changed the booking");

    // Clinic-caused → the cutoff is waived (the slot has not started).
    const waivedSlot = await createSlot(doctor.id, new Date(now + 45 * MINUTE), new Date(now + 105 * MINUTE));
    state.slotIds.push(waivedSlot);
    const unavailability = await prisma.doctorUnavailability.create({
      data: {
        doctorId: doctor.id,
        createdById: admin.id,
        startAt: new Date(now + 45 * MINUTE),
        endAt: new Date(now + 105 * MINUTE),
        reason: "Day21 DoD unavailability",
      },
      select: { id: true },
    });
    state.unavailabilityIds.push(unavailability.id);
    const waivedAppt = await createAppointment(doctor.id, waivedSlot, patientA.id, "CONFIRMED", fee, unavailability.id);
    state.appointmentIds.push(waivedAppt);
    const waived = await cancelAppointment({ actor: patientA, appointmentId: waivedAppt, requestId: "day21-dod" });
    expect(waived.status === "CANCELLED", "a clinic-caused cancellation was not waived past the cutoff");
    console.log("[6] patient cancel : before cutoff OK (seat freed) | inside cutoff → 409 CUTOFF_REACHED | clinic-caused waived");

    /* ---------------------------------------------------------------- */
    /* 7. Staff cancel of ARRIVED, and the auto-cancel job's restraint. */
    /* ---------------------------------------------------------------- */
    const arrivedCancelSlot = await createSlot(doctor.id, new Date(now - 5 * MINUTE), new Date(now + 55 * MINUTE));
    state.slotIds.push(arrivedCancelSlot);
    const arrivedCancelAppt = await createAppointment(doctor.id, arrivedCancelSlot, patientB.id, "CONFIRMED", fee);
    state.appointmentIds.push(arrivedCancelAppt);
    await arriveAppointment({ actor, appointmentId: arrivedCancelAppt, requestId: "day21-dod" });
    const staffCancelled = await cancelAppointment({
      actor,
      appointmentId: arrivedCancelAppt,
      reason: "Clinic error — double booked",
      requestId: "day21-dod",
    });
    expect(staffCancelled.status === "CANCELLED", "staff could not cancel an ARRIVED booking");
    expect(await bookedCount(arrivedCancelSlot) === 0, "staff cancellation of ARRIVED did not free the seat");

    // A clinic-caused booking already cancelled must not be touched by the §12 job.
    const jobSlot = await createSlot(doctor.id, new Date(now - 60 * MINUTE), new Date(now - 10 * MINUTE));
    state.slotIds.push(jobSlot);
    const jobUnavailability = await prisma.doctorUnavailability.create({
      data: {
        doctorId: doctor.id,
        createdById: admin.id,
        startAt: new Date(now - 60 * MINUTE),
        endAt: new Date(now - 10 * MINUTE),
        reason: "Day21 DoD job unavailability",
      },
      select: { id: true },
    });
    state.unavailabilityIds.push(jobUnavailability.id);
    const jobAppt = await createAppointment(doctor.id, jobSlot, patientB.id, "CONFIRMED", fee, jobUnavailability.id);
    state.appointmentIds.push(jobAppt);
    await cancelAppointment({ actor, appointmentId: jobAppt, reason: "Clinic caused — desk cancellation", requestId: "day21-dod" });
    const jobResult = await autoCancelAfterSlotEnd(new Date());
    expect(!jobResult.cancelledAppointmentIds.includes(jobAppt), "the auto-cancel job re-cancelled an already-cancelled booking");
    expect(await historyCount(jobAppt, "CANCELLED") === 1, "the cancelled booking has more than one CANCELLED history row");
    console.log("[7] staff cancel   : ARRIVED → CANCELLED (seat freed) | auto-cancel job left the cancelled row alone");

    /* ---------------------------------------------------------------- */
    /* 8. The race: two concurrent no-shows → exactly one wins.         */
    /* ---------------------------------------------------------------- */
    const raceSlot = await createSlot(doctor.id, new Date(now - 60 * MINUTE), new Date(now - 20 * MINUTE));
    state.slotIds.push(raceSlot);
    const raceAppt = await createAppointment(doctor.id, raceSlot, patientA.id, "CONFIRMED", fee);
    state.appointmentIds.push(raceAppt);

    const raceResults = await Promise.allSettled([
      markNoShow({ actor, appointmentId: raceAppt, requestId: "day21-dod" }),
      markNoShow({ actor, appointmentId: raceAppt, requestId: "day21-dod" }),
    ]);
    const raceWins = raceResults.filter((result) => result.status === "fulfilled");
    const raceLosses = raceResults.filter((result) => result.status === "rejected");
    expect(raceWins.length === 1, `scenario 8: expected exactly 1 winner, got ${raceWins.length}`);
    expect(raceLosses.length === 1, `scenario 8: expected exactly 1 loser, got ${raceLosses.length}`);
    const raceLoser = raceLosses[0]!;
    expect(
      raceLoser.status === "rejected" && raceLoser.reason instanceof AppError && raceLoser.reason.code === "INVALID_TRANSITION",
      "scenario 8: the loser was not refused 409 INVALID_TRANSITION",
    );
    expect(await historyCount(raceAppt, "NO_SHOW") === 1, "scenario 8: the race wrote more than one NO_SHOW history row");
    console.log("[8] no-show race   : 2 concurrent attempts → 1 NO_SHOW / 1 refused 409 | one history row");
  } finally {
    await cleanup(state);
  }

  console.log("DoD met: the §13 matrix and its clock/reason walls hold, the check-in flow records every");
  console.log("   change with its history and audit row, seats are freed exactly when they should be, the");
  console.log("   patient cutoff is enforced and waived only for clinic-caused bookings, and concurrent");
  console.log("   transitions resolve to exactly one winner.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
