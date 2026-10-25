// Day 19 DoD against the real local database:
//
//   npx tsx scripts/day19-dod.ts
//
// Proves the single correctness property plan.md §15 pins on booking: two
// people race for the last seat and exactly one wins.
//
//   1. Set up one bookable slot with EXACTLY ONE free seat (maxPatients = 1).
//   2. Fire two bookAppointment calls concurrently (two different patients).
//   3. Assert exactly one fulfilled and one rejected with 409 SLOT_FULL, the
//      stored bookedCount is 1 (never 2), and exactly one CONFIRMED appointment
//      exists — with its AppointmentHistory BOOKED event.
//   4. The winner booking the same slot again is refused 409 ALREADY_BOOKED
//      (the §15 same-slot rule, in front of the partial unique index).
//
// Clean-up: everything this run creates is removed in a `finally` and the slot's
// counters and capacity are restored, so the database ends as it started. The
// §20 AuditLog rows the service wrote are LEFT as residue (append-only; a
// re-seed resets everything) — the same bargain day16/18-dod.ts struck.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { enumerateDates, weekdayOfDate } from "../src/lib/slotPlan.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { AppError } from "../src/lib/appError.js";
import { listDoctorAvailability } from "../src/services/availability.service.js";
import { bookAppointment } from "../src/services/booking.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

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
  originalMaxPatients: number;
}

async function cleanup(state: RunState): Promise<void> {
  const ours = await prisma.appointment.findMany({ where: { slotId: state.slotId }, select: { id: true } });
  const ids = ours.map((row) => row.id);
  if (ids.length > 0) {
    await prisma.notification.deleteMany({ where: { appointmentId: { in: ids } } });
    await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: ids } } });
    await prisma.seatHold.deleteMany({ where: { appointmentId: { in: ids } } });
    // Day 26: every booking now owns a PENDING pay-at-clinic receivable.
    await prisma.payment.deleteMany({ where: { appointmentId: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.slot.update({
    where: { id: state.slotId },
    data: { bookedCount: 0, heldCount: 0, maxPatients: state.originalMaxPatients },
  });
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findFirst();
  if (!clinic) fail("No clinic row. Run the seed first (npm run db:seed).");

  const doctor = await prisma.user.findFirst({
    where: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    select: { id: true, fullName: true },
  });
  if (!doctor) fail("No VERIFIED doctor. Run the seed first (npm run db:seed).");

  const patients = await prisma.user.findMany({
    where: { role: "PATIENT", emailVerifiedAt: { not: null } },
    orderBy: { id: "asc" },
    take: 2,
    select: { id: true, fullName: true },
  });
  if (patients.length < 2) fail("Need at least two verified PATIENTs. Run the seed first (npm run db:seed).");

  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;
  const windows = await prisma.schedule.findMany({ where: { doctorId: doctor.id }, select: { weekday: true } });
  if (windows.length === 0) fail("The doctor has no schedule windows. Re-seed and retry.");

  // A FUTURE planned day (never today: today's windows may already have elapsed).
  const plannedDate = enumerateDates(today, clinic.bookingHorizonDays).find(
    (date) => date !== today && windows.some((w) => w.weekday === weekdayOfDate(date)),
  );
  if (!plannedDate) fail("No future planned slot date within the horizon for the doctor.");

  const listed = await listDoctorAvailability(doctor.id, plannedDate);
  if (listed.length === 0) fail(`No bookable slots on ${plannedDate} (expected at least one).`);

  // Pick an EMPTY bookable slot so the fixture destroys no real data.
  let slotId: string | undefined;
  let originalMaxPatients = 0;
  for (const candidate of listed) {
    const row = await prisma.slot.findUnique({
      where: { id: candidate.slotId },
      select: { id: true, bookedCount: true, heldCount: true, maxPatients: true },
    });
    if (row && row.bookedCount === 0 && row.heldCount === 0) {
      slotId = row.id;
      originalMaxPatients = row.maxPatients;
      break;
    }
  }
  if (!slotId) fail("No empty bookable slot to race over.");

  const state: RunState = { slotId, originalMaxPatients };

  // Start clean even after a crashed previous attempt: an empty slot cannot
  // legitimately carry an appointment, so purging ours is safe.
  await prisma.appointmentHistory.deleteMany({ where: { appointment: { slotId } } });
  await prisma.payment.deleteMany({ where: { appointment: { slotId } } });
  await prisma.appointment.deleteMany({ where: { slotId } });

  // Exactly one free seat.
  await prisma.slot.update({ where: { id: slotId }, data: { bookedCount: 0, heldCount: 0, maxPatients: 1 } });

  const actors: ActorContext[] = patients.map((p) => ({ id: p.id, role: "PATIENT", name: p.fullName }));

  console.log(`clinic      : ${clinic.name} (${clinic.timezone})`);
  console.log(`doctor      : ${doctor.fullName}`);
  console.log(`slot        : ${plannedDate} (maxPatients=1, 0 booked)`);
  console.log(`racers      : ${actors.map((a) => a.name).join(" vs ")}`);

  try {
    /* 1 + 2. The race for the last seat. */
    const results = await Promise.allSettled(
      actors.map((actor) => bookAppointment({ actor, slotId, ip: null, requestId: "day19-dod" })),
    );

    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");

    if (winners.length !== 1 || losers.length !== 1) {
      fail(`Expected exactly one winner and one loser, got ${winners.length} won / ${losers.length} lost.`);
    }

    const loser = losers[0]!;
    if (!(loser.reason instanceof AppError) || loser.reason.code !== "SLOT_FULL") {
      fail(`Expected the loser to be refused SLOT_FULL, got: ${String(loser.reason)}`);
    }

    const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
    const winner = winners[0]!.value as { id: string; patientId: string; status: string; feeAmount: number };
    if (winner.status !== "CONFIRMED") fail(`Winner appointment status was ${winner.status}, expected CONFIRMED.`);

    /* 3. No overbooking: one seat consumed, exactly one appointment. */
    const after = await prisma.slot.findUnique({
      where: { id: slotId },
      select: { bookedCount: true, heldCount: true, maxPatients: true },
    });
    if (after?.bookedCount !== 1) fail(`bookedCount is ${after?.bookedCount}, expected exactly 1 (no overbooking).`);
    if (after.bookedCount + after.heldCount > after.maxPatients) fail("booked + held exceeded maxPatients.");

    const appointments = await prisma.appointment.findMany({
      where: { slotId },
      select: { id: true, status: true, patientId: true },
    });
    if (appointments.length !== 1) fail(`Found ${appointments.length} appointments, expected exactly 1.`);
    if (appointments[0]!.patientId !== winner.patientId) fail("The stored appointment is not the winner's.");
    if (appointments[0]!.status !== "CONFIRMED") fail("The stored appointment is not CONFIRMED.");

    const history = await prisma.appointmentHistory.findFirst({
      where: { appointmentId: winner.id, eventType: "BOOKED" },
      select: { toStatus: true, fromStatus: true },
    });
    if (!history || history.toStatus !== "CONFIRMED" || history.fromStatus !== null) {
      fail("No BOOKED AppointmentHistory event (null → CONFIRMED) was written.");
    }
    console.log(
      `[1] last-seat race : winner = ${actors[winnerIndex]!.name} | loser refused 409 SLOT_FULL | bookedCount = 1`,
    );

    /* 4. Same-patient duplicate on the same slot. */
    const dupMessage = await expectRejection("ALREADY_BOOKED", "the winner re-booking the same slot", () =>
      bookAppointment({ actor: actors[winnerIndex]!, slotId, ip: null, requestId: "day19-dod" }),
    );
    console.log(`[2] same-slot rule : winner re-booking refused (${dupMessage})`);
  } finally {
    await cleanup(state);
  }

  console.log("DoD met: a last-seat race produces exactly one CONFIRMED booking — the guarded");
  console.log("   UPDATE refuses the second with SLOT_FULL, bookedCount never exceeds maxPatients,");
  console.log("   and one patient cannot hold two active bookings for the same slot.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
