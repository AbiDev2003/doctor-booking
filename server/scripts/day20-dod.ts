// Day 20 DoD against the real local database:
//
//   npx tsx scripts/day20-dod.ts
//
// Escalates the property Day 19 proved (a 2-racer last-seat race) into the
// concurrency shapes §15 actually has to survive, and proves the audit half of
// the day: every successful booking leaves exactly one AppointmentHistory
// BOOKED row and one AuditLog APPOINTMENT_BOOKED row, and losers leave none.
//
//   1. N-way overbooking : 5 distinct patients race for 2 seats — exactly 2
//      win, 3 are refused 409 SLOT_FULL, bookedCount never exceeds maxPatients.
//   2. Same-patient, same-slot, concurrent : the patient-row FOR UPDATE
//      serializes the two attempts, so exactly one books and the other is
//      refused 409 ALREADY_BOOKED — one appointment row, not two.
//   3. Same-patient cap race : one patient fires cap+1 concurrent bookings on
//      distinct slots — exactly cap succeed, the extra is 409
//      BOOKING_CAP_REACHED (the per-patient cap is a read-then-write made safe
//      by the same row lock).
//   4. Live hold counts toward the cap (§15) : cap-1 bookings + one live
//      SeatHold fills the cap; the next booking is refused BOOKING_CAP_REACHED,
//      and releasing the hold makes the identical booking succeed.
//   5. Audit + history residue : each of scenario 1's winners has exactly one
//      BOOKED history row and one APPOINTMENT_BOOKED audit row; the losers
//      created no appointment at all.
//   6. Audit read surface : listAuditEntries() finds a winner's audit row by
//      targetId and paginates newest-first on the (createdAt, id) cursor.
//
// Clean-up: this script creates its OWN patients and only races over slots that
// were empty, then restores every slot's counters and capacity in a `finally`,
// so the database ends as it started. The §20 AuditLog rows those synthetic
// patients wrote as actors are removed with them — an append-only row for a
// throwaway fixture actor would otherwise block the fixture's removal
// (audit_logs.actor_id is Restrict), which is the same bargain
// scripts/assert-constraints.ts strikes when it deletes its own ASSERT_TEST
// rows. Real rows are never touched.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { enumerateDates } from "../src/lib/slotPlan.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { AppError } from "../src/lib/appError.js";
import { parseAuditCursor } from "../src/lib/auditCursor.js";
import { listDoctorAvailability } from "../src/services/availability.service.js";
import { bookAppointment } from "../src/services/booking.service.js";
import { listAuditEntries } from "../src/services/audit.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const RACERS = 5;

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

interface EmptySlot {
  id: string;
  originalMaxPatients: number;
}

interface RunState {
  patientIds: string[];
  slots: EmptySlot[];
}

async function cleanup(state: RunState): Promise<void> {
  const patientIds = state.patientIds;
  const slotIds = state.slots.map((slot) => slot.id);

  const ours = await prisma.appointment.findMany({
    where: { OR: [{ patientId: { in: patientIds } }, { slotId: { in: slotIds } }] },
    select: { id: true },
  });
  const appointmentIds = ours.map((row) => row.id);

  if (appointmentIds.length > 0) {
    await prisma.notification.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
    await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  }
  // Holds first: both the synthetic hold and any appointment-linked hold point
  // at a patient and/or a slot, and both FKs are Restrict.
  await prisma.seatHold.deleteMany({
    where: { OR: [{ patientId: { in: patientIds } }, { slotId: { in: slotIds } }] },
  });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  // The synthetic patients wrote audit rows as actors; those must go before the
  // users they attribute to (audit_logs.actor_id is Restrict). See the header.
  await prisma.auditLog.deleteMany({ where: { actorId: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: patientIds } } });

  for (const slot of state.slots) {
    await prisma.slot.update({
      where: { id: slot.id },
      data: { bookedCount: 0, heldCount: 0, maxPatients: slot.originalMaxPatients },
    });
  }
}

/** Creates `count` verified synthetic patients, so the race never touches a real one. */
async function createRacers(count: number, tag: string): Promise<ActorContext[]> {
  const actors: ActorContext[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = await prisma.user.create({
      data: {
        role: "PATIENT",
        fullName: `Day20 ${tag} ${i}`,
        email: `day20-${tag}-${i}-${process.pid}@example.test`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true, fullName: true },
    });
    actors.push({ id: user.id, role: "PATIENT", name: user.fullName });
  }
  return actors;
}

/**
 * Removes synthetic fixtures a previous crashed run left behind — identified by
 * the `day20-` email prefix no real account uses. Without this a run that dies
 * between booking and clean-up would leak patients (and their audit rows) and
 * leave the slots they booked non-empty, so the next run could not find them.
 * Any slot a stale fixture touched was empty before it was booked, so its
 * counters are restored to zero here.
 */
async function purgeStaleFixtures(): Promise<number> {
  const stale = await prisma.user.findMany({
    where: { email: { startsWith: "day20-" } },
    select: { id: true },
  });
  const patientIds = stale.map((row) => row.id);
  if (patientIds.length === 0) return 0;

  const staleAppointments = await prisma.appointment.findMany({
    where: { patientId: { in: patientIds } },
    select: { id: true, slotId: true },
  });
  const appointmentIds = staleAppointments.map((row) => row.id);
  const touchedSlotIds = [...new Set(staleAppointments.map((row) => row.slotId))];

  if (appointmentIds.length > 0) {
    await prisma.notification.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
    await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  }
  await prisma.seatHold.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.appointment.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: patientIds } } });
  for (const slotId of touchedSlotIds) {
    await prisma.slot.update({ where: { id: slotId }, data: { bookedCount: 0, heldCount: 0 } });
  }
  return patientIds.length;
}

/** Walks the horizon collecting bookable slots that currently hold nothing. */
async function collectEmptySlots(doctorId: string, dates: readonly string[], needed: number): Promise<EmptySlot[]> {
  const found: EmptySlot[] = [];
  for (const date of dates) {
    const listed = await listDoctorAvailability(doctorId, date);
    if (listed.length === 0) continue;

    const rows = await prisma.slot.findMany({
      where: { id: { in: listed.map((slot) => slot.slotId) } },
      select: { id: true, bookedCount: true, heldCount: true, maxPatients: true },
    });
    for (const row of rows) {
      if (row.bookedCount === 0 && row.heldCount === 0) {
        found.push({ id: row.id, originalMaxPatients: row.maxPatients });
        if (found.length >= needed) return found;
      }
    }
  }
  return found;
}

async function main(): Promise<void> {
  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log(`purged      : ${purged} stale fixture patient(s) from a crashed run`);

  const clinic = await prisma.clinic.findFirst();
  if (!clinic) fail("No clinic row. Run the seed first (npm run db:seed).");
  const cap = clinic.maxActiveBookingsPerPatient;

  const doctor = await prisma.user.findFirst({
    where: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    select: { id: true, fullName: true },
  });
  if (!doctor) fail("No VERIFIED doctor. Run the seed first (npm run db:seed).");

  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;
  const futureDates = enumerateDates(today, clinic.bookingHorizonDays).filter((date) => date !== today);

  // race(1) + dup(1) + capRace(cap+1) + holdCap(cap+1)
  const needed = 2 + 2 * (cap + 1);
  const slots = await collectEmptySlots(doctor.id, futureDates, needed);
  if (slots.length < needed) {
    fail(
      `Found only ${slots.length} empty bookable slots, need ${needed}. Re-seed, or widen bookingHorizonDays, then retry.`,
    );
  }

  const raceSlot = slots[0]!;
  const dupSlot = slots[1]!;
  const capRaceSlots = slots.slice(2, 2 + (cap + 1));
  const holdCapSlots = slots.slice(2 + (cap + 1), 2 + 2 * (cap + 1));

  const state: RunState = { patientIds: [], slots };

  console.log(`clinic      : ${clinic.name} (${clinic.timezone})`);
  console.log(`doctor      : ${doctor.fullName}`);
  console.log(`cap         : maxActiveBookingsPerPatient = ${cap}`);
  console.log(`slots       : ${needed} empty slots across the horizon`);

  try {
    const racers = await createRacers(RACERS + 3, "racer");
    state.patientIds = racers.map((actor) => actor.id);

    // Start clean even after a crashed previous attempt.
    await prisma.appointmentHistory.deleteMany({ where: { appointment: { slotId: { in: slots.map((s) => s.id) } } } });
    await prisma.appointment.deleteMany({ where: { slotId: { in: slots.map((s) => s.id) } } });
    for (const slot of slots) {
      await prisma.slot.update({ where: { id: slot.id }, data: { bookedCount: 0, heldCount: 0 } });
    }
    await prisma.slot.update({ where: { id: raceSlot.id }, data: { maxPatients: 2 } });
    await prisma.slot.update({ where: { id: dupSlot.id }, data: { maxPatients: 2 } });

    /* 1. N-way overbooking: 5 distinct patients, 2 seats. */
    const raceResults = await Promise.allSettled(
      racers.slice(0, RACERS).map((actor) => bookAppointment({ actor, slotId: raceSlot.id, ip: null, requestId: "day20-dod" })),
    );
    const winners = raceResults.filter((result) => result.status === "fulfilled");
    const losers = raceResults.filter((result) => result.status === "rejected");

    expect(winners.length === 2, `scenario 1: expected exactly 2 winners, got ${winners.length}`);
    expect(losers.length === RACERS - 2, `scenario 1: expected ${RACERS - 2} losers, got ${losers.length}`);
    for (const loser of losers) {
      expect(
        loser.status === "rejected" && loser.reason instanceof AppError && loser.reason.code === "SLOT_FULL",
        `scenario 1: a loser was not refused SLOT_FULL (${String(loser.status === "rejected" ? loser.reason : "")})`,
      );
    }

    const raceAfter = await prisma.slot.findUniqueOrThrow({
      where: { id: raceSlot.id },
      select: { bookedCount: true, heldCount: true, maxPatients: true },
    });
    expect(raceAfter.bookedCount === 2, `scenario 1: bookedCount is ${raceAfter.bookedCount}, expected 2`);
    expect(
      raceAfter.bookedCount + raceAfter.heldCount <= raceAfter.maxPatients,
      "scenario 1: booked + held exceeded maxPatients — overbooked",
    );
    const raceAppointments = await prisma.appointment.findMany({
      where: { slotId: raceSlot.id },
      select: { id: true, status: true, patientId: true },
    });
    expect(raceAppointments.length === 2, `scenario 1: found ${raceAppointments.length} appointments, expected 2`);
    expect(
      raceAppointments.every((row) => row.status === "CONFIRMED"),
      "scenario 1: a stored appointment is not CONFIRMED",
    );
    console.log(`[1] overbooking     : ${winners.length} won / ${losers.length} refused 409 SLOT_FULL | bookedCount = 2`);

    /* 2. Same patient, same slot, concurrent. */
    const dupPatient = racers[5]!;
    const dupResults = await Promise.allSettled([
      bookAppointment({ actor: dupPatient, slotId: dupSlot.id, ip: null, requestId: "day20-dod" }),
      bookAppointment({ actor: dupPatient, slotId: dupSlot.id, ip: null, requestId: "day20-dod" }),
    ]);
    const dupWins = dupResults.filter((result) => result.status === "fulfilled");
    const dupLosses = dupResults.filter((result) => result.status === "rejected");
    expect(dupWins.length === 1, `scenario 2: expected exactly 1 success, got ${dupWins.length}`);
    expect(dupLosses.length === 1, `scenario 2: expected exactly 1 failure, got ${dupLosses.length}`);
    expect(
      dupLosses[0]!.status === "rejected" && dupLosses[0]!.reason instanceof AppError && dupLosses[0]!.reason.code === "ALREADY_BOOKED",
      "scenario 2: the loser was not refused ALREADY_BOOKED",
    );
    const dupAppointments = await prisma.appointment.count({ where: { slotId: dupSlot.id } });
    const dupSlotAfter = await prisma.slot.findUniqueOrThrow({ where: { id: dupSlot.id }, select: { bookedCount: true } });
    expect(dupAppointments === 1, `scenario 2: found ${dupAppointments} appointments, expected 1`);
    expect(dupSlotAfter.bookedCount === 1, `scenario 2: bookedCount is ${dupSlotAfter.bookedCount}, expected 1`);
    console.log(`[2] same-slot dup   : 1 booked / 1 refused 409 ALREADY_BOOKED | appointment rows = 1`);

    /* 3. Per-patient cap race: cap+1 concurrent bookings on distinct slots. */
    const capPatient = racers[6]!;
    const capResults = await Promise.allSettled(
      capRaceSlots.map((slot) => bookAppointment({ actor: capPatient, slotId: slot.id, ip: null, requestId: "day20-dod" })),
    );
    const capWins = capResults.filter((result) => result.status === "fulfilled");
    const capLosses = capResults.filter((result) => result.status === "rejected");
    expect(capWins.length === cap, `scenario 3: expected exactly ${cap} successes, got ${capWins.length}`);
    expect(capLosses.length === 1, `scenario 3: expected exactly 1 refusal, got ${capLosses.length}`);
    expect(
      capLosses[0]!.status === "rejected" &&
        capLosses[0]!.reason instanceof AppError &&
        capLosses[0]!.reason.code === "BOOKING_CAP_REACHED",
      "scenario 3: the extra attempt was not refused BOOKING_CAP_REACHED",
    );
    const capActive = await prisma.appointment.count({ where: { patientId: capPatient.id, status: "CONFIRMED" } });
    expect(capActive === cap, `scenario 3: patient holds ${capActive} active bookings, expected ${cap}`);
    console.log(`[3] cap race        : ${capWins.length} booked / 1 refused 409 BOOKING_CAP_REACHED | active = ${cap}`);

    /* 4. A live hold counts toward the cap (§15). */
    const holdPatient = racers[7]!;
    for (let i = 0; i < cap - 1; i += 1) {
      await bookAppointment({ actor: holdPatient, slotId: holdCapSlots[i]!.id, ip: null, requestId: "day20-dod" });
    }
    const holdSlot = holdCapSlots[cap - 1]!;
    const hold = await prisma.seatHold.create({
      data: {
        slotId: holdSlot.id,
        patientId: holdPatient.id,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
      select: { id: true },
    });
    const refusedSlot = holdCapSlots[cap]!;
    await expectRejection("BOOKING_CAP_REACHED", "booking while a live hold fills the cap", () =>
      bookAppointment({ actor: holdPatient, slotId: refusedSlot.id, ip: null, requestId: "day20-dod" }),
    );
    await prisma.seatHold.update({
      where: { id: hold.id },
      data: { releasedAt: new Date(), releaseReason: "ABANDONED" },
    });
    const afterRelease = await bookAppointment({
      actor: holdPatient,
      slotId: refusedSlot.id,
      ip: null,
      requestId: "day20-dod",
    });
    expect(afterRelease.status === "CONFIRMED", "scenario 4: the booking did not succeed after the hold was released");
    console.log(`[4] hold counts cap : refused over cap, permitted once the hold was released`);

    /* 5. Audit + history for each winner; nothing for the losers. */
    for (const winner of winners) {
      if (winner.status !== "fulfilled") fail("scenario 5: winner filter is broken");
      const appointmentId = winner.value.id;
      const history = await prisma.appointmentHistory.count({ where: { appointmentId, eventType: "BOOKED" } });
      const audits = await prisma.auditLog.count({
        where: { action: "APPOINTMENT_BOOKED", targetType: "appointment", targetId: appointmentId },
      });
      expect(history === 1, `scenario 5: ${appointmentId} has ${history} BOOKED history rows, expected 1`);
      expect(audits === 1, `scenario 5: ${appointmentId} has ${audits} APPOINTMENT_BOOKED audit rows, expected 1`);
    }
    console.log(`[5] audit + history : each winner has 1 BOOKED history + 1 APPOINTMENT_BOOKED audit`);

    /* 6. The audit read surface: filter by target + keyset pagination. */
    const firstWinner = winners[0]!;
    if (firstWinner.status !== "fulfilled") fail("scenario 6: winner filter is broken");
    const winnerId = firstWinner.value.id;
    const byTarget = await listAuditEntries({ targetId: winnerId, limit: 10 });
    expect(byTarget.entries.length === 1, `scenario 6: expected 1 audit row for ${winnerId}, got ${byTarget.entries.length}`);
    expect(byTarget.entries[0]!.action === "APPOINTMENT_BOOKED", "scenario 6: the audit row has the wrong action");

    const pageOne = await listAuditEntries({ limit: 1 });
    expect(pageOne.entries.length === 1, "scenario 6: the first page should hold 1 entry");
    expect(pageOne.nextCursor !== null, "scenario 6: a non-empty trail must return a next cursor");
    const pageTwo = await listAuditEntries({ limit: 1, cursor: parseAuditCursor(pageOne.nextCursor!) });
    expect(pageTwo.entries.length === 1, "scenario 6: the second page should hold 1 entry");
    expect(
      pageTwo.entries[0]!.id !== pageOne.entries[0]!.id,
      "scenario 6: the keyset cursor returned the same row twice",
    );
    console.log(`[6] audit read      : targetId filter + newest-first keyset pagination`);
  } finally {
    await cleanup(state);
  }

  console.log("DoD met: the last-seat guard holds under 5-way and same-patient races, the per-patient");
  console.log("   cap counts live holds, and every booking is audited and in its history with no loser residue.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
