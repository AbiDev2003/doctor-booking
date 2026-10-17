// Day 22 DoD against the real local database:
//
//   npx tsx scripts/day22-dod.ts
//
// Proves plan.md §14's reschedule through the real Day 22 service (not the pure
// guard alone):
//
//   1. THE HAPPY PATH. A patient moves their own booking to another slot of the
//      same doctor: the OLD seat is released, the NEW seat is claimed, the row
//      keeps CONFIRMED and the same bookingTime, and a RESCHEDULED history event
//      + APPOINTMENT_RESCHEDULED audit row + notification are written.
//   2. THE SCOPE RULES. The same slot is refused 422 SAME_SLOT; a patient
//      crossing to another doctor is refused 403 CROSS_DOCTOR_RESCHEDULE; a
//      doctor may not reschedule at all (403 FORBIDDEN); another patient's
//      booking is 403 FORBIDDEN.
//   3. THE STATUS RULE. An ARRIVED (or terminal) booking cannot be rescheduled
//      (409 INVALID_TRANSITION).
//   4. THE §8.5 CUTOFF. A patient inside the cutoff is refused 409 CUTOFF_REACHED
//      with the booking untouched; a clinic-caused booking is waived past the
//      cutoff, and its marker is CLEARED by the move.
//   5. STAFF CROSS-DOCTOR. Refused 422 REASON_REQUIRED without a reason; with
//      one it moves across doctors, updates the doctor/name/fee snapshots, and
//      records the §14 delta in the history metadata. Staff are not bound by
//      the cutoff.
//   6. TARGET GUARDS. A full target is 409 SLOT_FULL; a disabled one is
//      409 SLOT_DISABLED.
//   7. THE RACES. Two patients racing into one last seat → exactly one wins;
//      two concurrent reschedules of ONE booking → exactly one wins, with one
//      RESCHEDULED history row.
//
// Clean-up: this script creates its OWN patients and its own synthetic slots,
// then removes every row it created in a `finally`, so the database ends as it
// started. §20 AuditLog rows the real ADMIN actor wrote are LEFT as residue
// (append-only; a re-seed resets everything) — the day16/18/19/20/21 bargain.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { $Enums, PrismaClient } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { addCalendarDays, localDateTimeToUtc, utcToLocalDateTime } from "../src/lib/time.js";
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

const FIXTURE_EMAIL_PREFIX = "day22-";
const DOCTOR_NAME_MARKER = "Day22 DoD synthetic";
const MINUTE = 60_000;

function fail(message: string): never {
  // Throws rather than `process.exit` so the `finally` cleanup always runs: an
  // early exit would leak every fixture this run created (day21-dod.ts's
  // process.exit flavour is why the purge below has to exist at all).
  throw new Error(`FAIL: ${message}`);
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

interface RunState {
  patientIds: string[];
  slotIds: string[];
  appointmentIds: string[];
  unavailabilityIds: string[];
}

async function cleanup(state: RunState): Promise<void> {
  if (state.appointmentIds.length > 0) {
    await prisma.notification.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.refund.deleteMany({ where: { payment: { appointmentId: { in: state.appointmentIds } } } });
    await prisma.payment.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
    await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: state.appointmentIds } } });
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
 * Removes fixtures a previous crashed run left behind. Two shapes are purged,
 * because a run can die between creating a slot and linking it to a patient:
 *
 * - patients under the `day22-` email prefix (with their appointments + slots);
 * - synthetic SLOTS: the 2000-01-* "old slot" dates, and future slots on a
 *   `:07` minute — the shapes `createOldSlot`/`createTargetSlot` emit and no
 *   generated slot ever has (the seed materialises whole :00 hours).
 */
async function purgeStaleFixtures(today: string): Promise<number> {
  const stale = await prisma.user.findMany({ where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } }, select: { id: true } });
  const patientIds = stale.map((row) => row.id);

  const syntheticSlots = await prisma.slot.findMany({
    where: { OR: [{ slotDate: { lt: new Date("2001-01-01T00:00:00.000Z") } }, { slotDate: { gte: new Date(`${today}T00:00:00.000Z`) } }] },
    select: { id: true, slotDate: true, startTime: true },
  });
  const slotIds = syntheticSlots
    .filter((row) => row.slotDate.getUTCFullYear() === 2000 || row.startTime.getUTCMinutes() === 7)
    .map((row) => row.id);

  const appointments = await prisma.appointment.findMany({
    where: {
      OR: [{ patientId: { in: patientIds } }, { slotId: { in: slotIds } }],
    },
    select: { id: true, slotId: true },
  });
  const appointmentIds = appointments.map((row) => row.id);
  const involvedSlotIds = [...new Set([...slotIds, ...appointments.map((row) => row.slotId)])];

  if (appointmentIds.length === 0 && patientIds.length === 0 && involvedSlotIds.length === 0) return 0;

  await prisma.notification.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.refund.deleteMany({ where: { payment: { appointmentId: { in: appointmentIds } } } });
  await prisma.payment.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.seatHold.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await prisma.slot.deleteMany({ where: { id: { in: involvedSlotIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: patientIds } } });
  return patientIds.length;
}

async function createPatients(count: number): Promise<ActorContext[]> {
  const actors: ActorContext[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = await prisma.user.create({
      data: {
        role: "PATIENT",
        fullName: `Day22 patient ${i}`,
        email: `${FIXTURE_EMAIL_PREFIX}patient-${i}-${process.pid}@example.test`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true, fullName: true },
    });
    actors.push({ id: user.id, role: "PATIENT", name: user.fullName });
  }
  return actors;
}

/**
 * A synthetic slot whose `startAt`/`endAt` are positioned by the caller. Used
 * for OLD slots (the ones an appointment is leaving): the reschedule service
 * reads only their instants for the §8.5 cutoff, never their horizon, so a
 * 2000-01-* date (outside any real calendar, no collision with a generated
 * slot) is exactly what day21-dod.ts uses.
 */
let oldSlotSeq = 0;
async function createOldSlot(doctorId: string, startAt: Date, endAt: Date): Promise<string> {
  oldSlotSeq += 1;
  const slot = await prisma.slot.create({
    data: {
      doctorId,
      slotDate: new Date(Date.UTC(2000, 0, oldSlotSeq)),
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

/**
 * A TARGET slot, which the service DOES check against the §10 horizon: its
 * `slotDate` must sit inside `[today, today + horizon]` and its instants must be
 * real. Each fixture gets a distinct future date and an odd `:07` minute so it
 * can never collide with a generated slot (those start on the hour inside the
 * seeded 09–12 / 17–20 windows).
 */
let targetSeq = 0;
async function createTargetSlot(
  doctorId: string,
  today: string,
  timezone: string,
  opts: { maxPatients?: number; isDisabled?: boolean } = {},
): Promise<string> {
  targetSeq += 1;
  const date = addCalendarDays(today, 5 + targetSeq);
  const hour = String((targetSeq % 8) + 1).padStart(2, "0");
  const time = `${hour}:07:00`;
  const startAt = localDateTimeToUtc({ date, time }, timezone);
  const endAt = new Date(startAt.getTime() + 60 * MINUTE);

  const slot = await prisma.slot.create({
    data: {
      doctorId,
      slotDate: new Date(`${date}T00:00:00.000Z`),
      startTime: new Date(`1970-01-01T${time.slice(0, 5)}:00.000Z`),
      endTime: new Date(`1970-01-01T${utcToLocalDateTime(endAt, timezone).time.slice(0, 5)}:00.000Z`),
      startAt,
      endAt,
      maxPatients: opts.maxPatients ?? 5,
      bookedCount: 0,
      heldCount: 0,
      isDisabled: opts.isDisabled ?? false,
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

async function rescheduledHistoryCount(appointmentId: string): Promise<number> {
  return prisma.appointmentHistory.count({
    where: { appointmentId, eventType: $Enums.AppointmentEventType.RESCHEDULED },
  });
}

async function auditCount(action: string, appointmentId: string): Promise<number> {
  return prisma.auditLog.count({ where: { action, targetType: "appointment", targetId: appointmentId } });
}

function feeOf(profile: { consultationFee: number | null } | null, fallback: number): number {
  return profile?.consultationFee ?? fallback;
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findFirst();
  if (!clinic) fail("No clinic row. Run the seed first (npm run db:seed).");

  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;
  const purged = await purgeStaleFixtures(today);
  if (purged > 0) console.log(`purged      : ${purged} stale fixture patient(s) from a crashed run`);

  const doctors = await prisma.user.findMany({
    where: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    orderBy: { id: "asc" },
    take: 2,
    select: { id: true, fullName: true, doctorProfile: { select: { consultationFee: true } } },
  });
  if (doctors.length < 2) fail("Need two VERIFIED doctors. Run the seed first (npm run db:seed).");
  const [doctorA, doctorB] = doctors;
  if (!doctorA || !doctorB) fail("the two verified doctors were not returned");

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, fullName: true } });
  if (!admin) fail("No ADMIN user. Run the seed first (npm run db:seed).");
  const adminActor: ActorContext = { id: admin.id, role: "ADMIN", name: admin.fullName };
  const doctorActor: ActorContext = { id: doctorA.id, role: "DOCTOR", name: doctorA.fullName };

  const feeA = feeOf(doctorA.doctorProfile, clinic.defaultConsultationFee);
  const feeB = feeOf(doctorB.doctorProfile, clinic.defaultConsultationFee);

  const state: RunState = { patientIds: [], slotIds: [], appointmentIds: [], unavailabilityIds: [] };
  const now = Date.now();

  console.log(`clinic      : ${clinic.name} (${clinic.timezone}, cutoff ${clinic.cancelCutoffMinutes}m)`);
  console.log(`doctor A/B  : ${doctorA.fullName} (${feeA}p) / ${doctorB.fullName} (${feeB}p)`);
  console.log(`actor       : ${admin.fullName} (ADMIN)`);

  try {
    const patients = await createPatients(3);
    state.patientIds = patients.map((patient) => patient.id);
    const [patientA, patientB, patientC] = patients;
    if (!patientA || !patientB || !patientC) fail("scenario 0: the synthetic patients were not created");

    /* ---------------------------------------------------------------- */
    /* 1. The happy path: a patient moves their own booking.            */
    /* ---------------------------------------------------------------- */
    const happyOld = await createOldSlot(doctorA.id, new Date(now + 300 * MINUTE), new Date(now + 360 * MINUTE));
    const happyTarget = await createTargetSlot(doctorA.id, today, clinic.timezone);
    state.slotIds.push(happyOld, happyTarget);
    const happyAppt = await createAppointment(doctorA.id, happyOld, patientA.id, "CONFIRMED", feeA);
    state.appointmentIds.push(happyAppt);

    const moved = await rescheduleAppointment({
      actor: patientA,
      appointmentId: happyAppt,
      slotId: happyTarget,
      requestId: "day22-dod",
    });
    expect(moved.slotId === happyTarget, `the move left slotId ${moved.slotId}`);
    expect(moved.status === "CONFIRMED", `the move changed the status to ${moved.status}`);
    expect(moved.feeAmount === feeA, `the fee changed on a same-doctor move (${moved.feeAmount} vs ${feeA})`);
    expect((await bookedCount(happyOld)) === 0, "the OLD seat was not released");
    expect((await bookedCount(happyTarget)) === 1, "the NEW seat was not claimed");
    expect((await rescheduledHistoryCount(happyAppt)) === 1, "no single RESCHEDULED history event");
    expect((await auditCount("APPOINTMENT_RESCHEDULED", happyAppt)) === 1, "no APPOINTMENT_RESCHEDULED audit row");
    expect(
      (await prisma.notification.count({ where: { appointmentId: happyAppt, type: "APPOINTMENT_RESCHEDULED" } })) === 1,
      "no APPOINTMENT_RESCHEDULED notification queued",
    );
    const history = await prisma.appointmentHistory.findFirstOrThrow({
      where: { appointmentId: happyAppt, eventType: "RESCHEDULED" },
      select: { fromStatus: true, toStatus: true, metadata: true },
    });
    const metadata = history.metadata as Record<string, unknown>;
    expect(history.fromStatus === "CONFIRMED" && history.toStatus === "CONFIRMED", "the history event is not CONFIRMED → CONFIRMED");
    expect(metadata.fromSlotId === happyOld && metadata.toSlotId === happyTarget, "the history metadata lacks the old→new slot");
    expect(metadata.deltaPaise === 0, `the recorded delta is ${String(metadata.deltaPaise)}, expected 0`);
    console.log("[1] happy path     : row moved CONFIRMED→CONFIRMED | old seat freed / new claimed | history + audit + notification");

    /* ---------------------------------------------------------------- */
    /* 2. The scope rules.                                              */
    /* ---------------------------------------------------------------- */
    await expectRejection("SAME_SLOT", "rescheduling into the same slot", () =>
      rescheduleAppointment({ actor: patientA, appointmentId: happyAppt, slotId: happyTarget, requestId: "day22-dod" }),
    );

    const crossTarget = await createTargetSlot(doctorB.id, today, clinic.timezone);
    state.slotIds.push(crossTarget);
    await expectRejection("CROSS_DOCTOR_RESCHEDULE", "a patient crossing doctors", () =>
      rescheduleAppointment({ actor: patientA, appointmentId: happyAppt, slotId: crossTarget, requestId: "day22-dod" }),
    );

    await expectRejection("FORBIDDEN", "a doctor rescheduling", () =>
      rescheduleAppointment({ actor: doctorActor, appointmentId: happyAppt, slotId: happyTarget, requestId: "day22-dod" }),
    );

    await expectRejection("FORBIDDEN", "another patient moving patientA's booking", () =>
      rescheduleAppointment({ actor: patientB, appointmentId: happyAppt, slotId: happyTarget, requestId: "day22-dod" }),
    );
    console.log("[2] scope rules    : SAME_SLOT | CROSS_DOCTOR_RESCHEDULE | doctor FORBIDDEN | stranger FORBIDDEN");

    /* ---------------------------------------------------------------- */
    /* 3. The status rule: only CONFIRMED moves.                        */
    /* ---------------------------------------------------------------- */
    const arrivedSlot = await createOldSlot(doctorA.id, new Date(now - 10 * MINUTE), new Date(now + 50 * MINUTE));
    state.slotIds.push(arrivedSlot);
    const arrivedAppt = await createAppointment(doctorA.id, arrivedSlot, patientA.id, "ARRIVED", feeA);
    state.appointmentIds.push(arrivedAppt);
    await expectRejection("INVALID_TRANSITION", "rescheduling an ARRIVED booking", () =>
      rescheduleAppointment({ actor: patientA, appointmentId: arrivedAppt, slotId: happyTarget, requestId: "day22-dod" }),
    );
    console.log("[3] status rule    : an ARRIVED booking is refused 409 INVALID_TRANSITION");

    /* ---------------------------------------------------------------- */
    /* 4. The §8.5 patient cutoff and its clinic-caused waiver.         */
    /* ---------------------------------------------------------------- */
    const waiverTarget = await createTargetSlot(doctorA.id, today, clinic.timezone);
    const nearOld = await createOldSlot(doctorA.id, new Date(now + 45 * MINUTE), new Date(now + 105 * MINUTE));
    state.slotIds.push(waiverTarget, nearOld);
    const nearAppt = await createAppointment(doctorA.id, nearOld, patientA.id, "CONFIRMED", feeA);
    state.appointmentIds.push(nearAppt);
    await expectRejection("CUTOFF_REACHED", "rescheduling inside the cutoff window", () =>
      rescheduleAppointment({ actor: patientA, appointmentId: nearAppt, slotId: waiverTarget, requestId: "day22-dod" }),
    );
    const nearRow = await prisma.appointment.findUniqueOrThrow({ where: { id: nearAppt }, select: { slotId: true } });
    expect(nearRow.slotId === nearOld, "a refused reschedule moved the booking anyway");

    // Clinic-caused (marker set) → the cutoff is waived; the move clears the marker.
    const unavailability = await prisma.doctorUnavailability.create({
      data: {
        doctorId: doctorA.id,
        createdById: admin.id,
        startAt: new Date(now + 45 * MINUTE),
        endAt: new Date(now + 105 * MINUTE),
        reason: "Day22 DoD unavailability",
      },
      select: { id: true },
    });
    state.unavailabilityIds.push(unavailability.id);
    const flaggedAppt = await createAppointment(doctorA.id, nearOld, patientB.id, "CONFIRMED", feeA, unavailability.id);
    state.appointmentIds.push(flaggedAppt);
    const waived = await rescheduleAppointment({
      actor: patientB,
      appointmentId: flaggedAppt,
      slotId: waiverTarget,
      requestId: "day22-dod",
    });
    expect(waived.slotId === waiverTarget, "a clinic-caused reschedule past the cutoff did not move");
    const cleared = await prisma.appointment.findUniqueOrThrow({
      where: { id: flaggedAppt },
      select: { doctorUnavailabilityId: true },
    });
    expect(cleared.doctorUnavailabilityId === null, "the clinic-caused marker was not cleared by the move");
    console.log("[4] cutoff + waiver: inside cutoff → 409 CUTOFF_REACHED | clinic-caused waived | marker cleared");

    /* ---------------------------------------------------------------- */
    /* 5. Staff cross-doctor: reason rule and fee-delta snapshot.       */
    /* ---------------------------------------------------------------- */
    const staffOld = await createOldSlot(doctorA.id, new Date(now + 300 * MINUTE), new Date(now + 360 * MINUTE));
    const staffTarget = await createTargetSlot(doctorB.id, today, clinic.timezone);
    state.slotIds.push(staffOld, staffTarget);
    const staffAppt = await createAppointment(doctorA.id, staffOld, patientC.id, "CONFIRMED", feeA);
    state.appointmentIds.push(staffAppt);

    await expectRejection("REASON_REQUIRED", "a staff cross-doctor move without a reason", () =>
      rescheduleAppointment({ actor: adminActor, appointmentId: staffAppt, slotId: staffTarget, requestId: "day22-dod" }),
    );

    const staffMoved = await rescheduleAppointment({
      actor: adminActor,
      appointmentId: staffAppt,
      slotId: staffTarget,
      reason: "Doctor A called in unavailable — moved at the desk",
      requestId: "day22-dod",
    });
    expect(staffMoved.doctorId === doctorB.id, "the move did not switch the appointment to doctor B");
    expect(staffMoved.doctorName === doctorB.fullName, "the doctorName snapshot was not updated");
    expect(staffMoved.feeAmount === feeB, `the fee snapshot is ${staffMoved.feeAmount}, expected doctor B's ${feeB}`);
    const staffMeta = (
      await prisma.appointmentHistory.findFirstOrThrow({
        where: { appointmentId: staffAppt, eventType: "RESCHEDULED" },
        select: { metadata: true },
      })
    ).metadata as Record<string, unknown>;
    expect(staffMeta.deltaPaise === feeB - feeA, `the recorded delta is ${String(staffMeta.deltaPaise)}, expected ${feeB - feeA}`);
    console.log("[5] staff cross-doc: refused without a reason | moves | doctor + fee snapshots updated | delta recorded");

    /* ---------------------------------------------------------------- */
    /* 6. Target guards: full and disabled.                             */
    /* ---------------------------------------------------------------- */
    const fullTarget = await createTargetSlot(doctorA.id, today, clinic.timezone, { maxPatients: 1 });
    state.slotIds.push(fullTarget);
    const occupant = await createAppointment(doctorA.id, fullTarget, patientC.id, "CONFIRMED", feeA);
    state.appointmentIds.push(occupant);
    const fullOld = await createOldSlot(doctorA.id, new Date(now + 300 * MINUTE), new Date(now + 360 * MINUTE));
    state.slotIds.push(fullOld);
    const fullAppt = await createAppointment(doctorA.id, fullOld, patientA.id, "CONFIRMED", feeA);
    state.appointmentIds.push(fullAppt);
    await expectRejection("SLOT_FULL", "moving into a full target", () =>
      rescheduleAppointment({ actor: patientA, appointmentId: fullAppt, slotId: fullTarget, requestId: "day22-dod" }),
    );

    const disabledTarget = await createTargetSlot(doctorA.id, today, clinic.timezone, { isDisabled: true });
    state.slotIds.push(disabledTarget);
    await expectRejection("SLOT_DISABLED", "moving into a disabled target", () =>
      rescheduleAppointment({ actor: patientA, appointmentId: fullAppt, slotId: disabledTarget, requestId: "day22-dod" }),
    );
    console.log("[6] target guards  : full → 409 SLOT_FULL | disabled → 409 SLOT_DISABLED");

    /* ---------------------------------------------------------------- */
    /* 7a. The last-seat race: two patients into one seat.              */
    /* ---------------------------------------------------------------- */
    const raceTarget = await createTargetSlot(doctorA.id, today, clinic.timezone, { maxPatients: 1 });
    const raceOldX = await createOldSlot(doctorA.id, new Date(now + 300 * MINUTE), new Date(now + 360 * MINUTE));
    const raceOldY = await createOldSlot(doctorA.id, new Date(now + 300 * MINUTE), new Date(now + 360 * MINUTE));
    state.slotIds.push(raceTarget, raceOldX, raceOldY);
    const raceX = await createAppointment(doctorA.id, raceOldX, patientA.id, "CONFIRMED", feeA);
    const raceY = await createAppointment(doctorA.id, raceOldY, patientB.id, "CONFIRMED", feeA);
    state.appointmentIds.push(raceX, raceY);

    const seatRace = await Promise.allSettled([
      rescheduleAppointment({ actor: patientA, appointmentId: raceX, slotId: raceTarget, requestId: "day22-dod" }),
      rescheduleAppointment({ actor: patientB, appointmentId: raceY, slotId: raceTarget, requestId: "day22-dod" }),
    ]);
    const seatWins = seatRace.filter((result) => result.status === "fulfilled");
    const seatLosses = seatRace.filter((result) => result.status === "rejected");
    expect(seatWins.length === 1, `scenario 7a: expected 1 winner, got ${seatWins.length}`);
    expect(seatLosses.length === 1, `scenario 7a: expected 1 loser, got ${seatLosses.length}`);
    const seatLoser = seatLosses[0]!;
    expect(
      seatLoser.status === "rejected" && seatLoser.reason instanceof AppError && seatLoser.reason.code === "SLOT_FULL",
      "scenario 7a: the loser was not refused 409 SLOT_FULL",
    );
    expect((await bookedCount(raceTarget)) === 1, "scenario 7a: the target seat count is not 1");
    console.log("[7a] last-seat race : 2 patients → 1 winner / 1 refused 409 SLOT_FULL | target bookedCount = 1");

    /* ---------------------------------------------------------------- */
    /* 7b. The double-move race: two reschedules of ONE booking.        */
    /* ---------------------------------------------------------------- */
    const moveOld = await createOldSlot(doctorA.id, new Date(now + 300 * MINUTE), new Date(now + 360 * MINUTE));
    const moveTargetX = await createTargetSlot(doctorA.id, today, clinic.timezone);
    const moveTargetY = await createTargetSlot(doctorA.id, today, clinic.timezone);
    state.slotIds.push(moveOld, moveTargetX, moveTargetY);
    const moveAppt = await createAppointment(doctorA.id, moveOld, patientA.id, "CONFIRMED", feeA);
    state.appointmentIds.push(moveAppt);

    const moveRace = await Promise.allSettled([
      rescheduleAppointment({ actor: patientA, appointmentId: moveAppt, slotId: moveTargetX, requestId: "day22-dod" }),
      rescheduleAppointment({ actor: patientA, appointmentId: moveAppt, slotId: moveTargetY, requestId: "day22-dod" }),
    ]);
    const moveWins = moveRace.filter((result) => result.status === "fulfilled");
    const moveLosses = moveRace.filter((result) => result.status === "rejected");
    expect(moveWins.length === 1, `scenario 7b: expected 1 winner, got ${moveWins.length}`);
    expect(moveLosses.length === 1, `scenario 7b: expected 1 loser, got ${moveLosses.length}`);
    const moveLoser = moveLosses[0]!;
    expect(
      moveLoser.status === "rejected" && moveLoser.reason instanceof AppError && moveLoser.reason.code === "INVALID_TRANSITION",
      "scenario 7b: the loser was not refused 409 INVALID_TRANSITION",
    );
    expect((await rescheduledHistoryCount(moveAppt)) === 1, "scenario 7b: more than one RESCHEDULED history row");
    const moveSeatTotal = (await bookedCount(moveTargetX)) + (await bookedCount(moveTargetY));
    expect(moveSeatTotal === 1, `scenario 7b: target seats total ${moveSeatTotal}, expected 1`);
    console.log("[7b] double-move    : 2 concurrent moves of one booking → 1 win / 1 refused 409 INVALID_TRANSITION | one history row");
  } finally {
    await cleanup(state);
  }

  console.log("DoD met: a reschedule moves the same row to a new slot with the old seat released and the new one");
  console.log("   claimed, enforces the §14 scope/status/cutoff rules and the §8.5 waiver (clearing the clinic-caused");
  console.log("   marker), settles the §14 fee delta, records history + audit + notification, and resolves concurrent");
  console.log("   moves to exactly one winner.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
