// Day 16 DoD against the real local database:
//
//   npx tsx scripts/day16-dod.ts
//
// Proves, through the actual services (not the pure guard alone), the two
// properties plan.md §8.4 pins on dated-slot edits:
//
//   1. THE SEAT-OR-HOLD GUARD IS NOT OPTIONAL. A slot carrying a synthetic
//      CONFIRMED appointment AND a live SeatHold refuses BOTH a time/date edit
//      and a disable with `409 SLOT_HELD` — the same shared predicate (decision
//      3), through the whole service stack, exactly as it will refuse a real
//      patient's booking.
//   2. A CAPACITY RAISE IS ALWAYS ALLOWED AND ALWAYS AUDITED. The same slot,
//      once the synthetic booking/hold is removed, accepts `maxPatients + 1`
//      (capacity-only edits skip the seat test), and the AuditLog lands exactly
//      one `SLOT_CAPACITY_CHANGE` row with the before/after snapshot (decision 8).
//
// Plus the two create walls for free (no mutation):
//   - a manual create of an already-existing window is refused (SLOT_OVERLAP,
//     which is the top of the two stacked walls — decision 6's unique-key
//     SLOT_EXISTS is the race backstop beneath it);
//   - a manual create beyond the booking horizon is refused (422
//     SLOT_OUTSIDE_HORIZON, decision 6).
//
// Clean-up: removes the synthetic appointment and hold it created; the two
// capacity audit rows plus the slot's restored maxPatients are the only residue
// (a re-seed resets everything — clinic row is re-upserted, slots regenerated).

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { enumerateDates, weekdayOfDate } from "../src/lib/slotPlan.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { AppError } from "../src/lib/appError.js";
import {
  createSlot,
  setSlotDisabled,
  updateSlot,
} from "../src/services/slot.service.js";
import type { Prisma } from "../src/generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

function oneDayLater(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  const next = new Date(Date.UTC(year, month, day + 1)).toISOString().slice(0, 10);
  return next;
}

/** Expects `fn` to reject with an AppError carrying `code`; returns the message. */
async function expectRejection(code: string, what: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    console.error(`FAIL: expected ${code} for ${what}, but the call succeeded.`);
    process.exit(1);
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
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findUnique({ where: { id: "0c000000-0000-4000-8000-000000000001" } });
  if (!clinic) {
    console.error("No clinic row. Run the seed first (npm run db:seed).");
    process.exit(1);
  }

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  if (!admin) {
    console.error("No ADMIN user. Run the seed first (npm run db:seed).");
    process.exit(1);
  }
  const actor = { id: admin.id, role: "ADMIN" as const, name: "day16-dod" };

  const patient = await prisma.user.findFirst({ where: { role: "PATIENT" }, select: { id: true } });
  if (!patient) {
    console.error("No PATIENT user. Run the seed first (npm run db:seed).");
    process.exit(1);
  }

  // Self-cleaning: purge anything a previous aborted run left behind. The
  // script is meant to be re-runnable, and an orphaned synthetic booking from
  // a crash would trip the exact unique indexes we are about to exercise.
  const orphans = await prisma.appointment.findMany({ where: { doctorName: "DoD synthetic doctor" }, select: { id: true } });
  for (const orphan of orphans) {
    await prisma.seatHold.deleteMany({ where: { appointmentId: orphan.id } });
    await prisma.appointment.delete({ where: { id: orphan.id } });
  }
  await prisma.seatHold.deleteMany({ where: { patientId: patient.id } });
  if (orphans.length > 0) console.log(`[cleanup] removed ${orphans.length} stale synthetic appointment(s) from a previous run`);

  const clinicLocalToday = utcToLocalDateTime(new Date(), clinic.timezone).date;

  // A bookable doctor's slot inside the current horizon, plucked via the SAME
  // pure planner the generator trusts, so the DoD is asserting against a real
  // generated window.
  const doctor = await prisma.user.findFirst({
    where: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    select: { id: true },
  });
  if (!doctor) {
    console.error("No VERIFIED doctor. Run the seed first (npm run db:seed).");
    process.exit(1);
  }

  const windows = await prisma.schedule.findMany({
    where: { doctorId: doctor.id },
    select: { weekday: true, startTime: true, endTime: true, maxPatients: true },
  });
  if (windows.length === 0) {
    console.error("The doctor has no schedule windows. Re-seed and retry.");
    process.exit(1);
  }
  const plannedDate = enumerateDates(clinicLocalToday, clinic.bookingHorizonDays).find((date) =>
    windows.some((w) => w.weekday === weekdayOfDate(date)),
  );
  if (!plannedDate) {
    console.error("No planned slot date within the horizon for the doctor.");
    process.exit(1);
  }

  const slot = await prisma.slot.findFirst({
    where: {
      doctorId: doctor.id,
      slotDate: new Date(`${plannedDate}T00:00:00.000Z`),
    },
    orderBy: { startTime: "asc" },
  });
  if (!slot) {
    console.error("Expected a generated slot for the chosen doctor/date; none found.");
    process.exit(1);
  }

  const slotStart = slot.startTime.toISOString().slice(11, 16);
  const slotEnd = slot.endTime.toISOString().slice(11, 16);
  const endHour = Number(slotEnd.slice(0, 2));
  const shifted = `${String(endHour + 1).padStart(2, "0")}:${slotEnd.slice(3, 5)}`;

  console.log(`clinic        : ${clinic.name} (${clinic.timezone}, horizon ${clinic.bookingHorizonDays}d)`);
  console.log(`doctor        : ${doctor.id}`);
  console.log(`patient       : ${patient.id}`);
  console.log(`target slot   : ${plannedDate} ${slotStart}–${slotEnd} (${slot.maxPatients} max)`);

  /* ------------------------------------------------------------------ */
  /* 1. The seat-or-hold guard (decision 3): a real CONFIRMED appointment */
  /*    plus a live hold refuses the time edit AND the disable,           */
  /*    through the actual services.                                      */
  /* ------------------------------------------------------------------ */

  let appointmentId: string | undefined;
  let holdId: string | undefined;
  try {
    const appointment = await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patient.id,
        slotId: slot.id,
        status: "CONFIRMED",
        doctorName: "DoD synthetic doctor",
        feeAmount: clinic.defaultConsultationFee,
      },
    });
    appointmentId = appointment.id;
    const hold = await prisma.seatHold.create({
      data: {
        slotId: slot.id,
        patientId: patient.id,
        // §8.6: expiresAt capped at slot.startAt — a live hold, unreleased.
        expiresAt: slot.startAt,
      },
    });
    holdId = hold.id;

    const timeEditMsg = await expectRejection(
      "SLOT_HELD",
      `a time edit of ${plannedDate} ${slotStart}–${slotEnd} (shift end to ${shifted})`,
      () =>
        updateSlot({
          actor,
          slotId: slot.id,
          patch: { endTime: shifted },
          reason: "DoD: must be refused while a patient's booking exists",
        }),
    );
    const disableMsg = await expectRejection("SLOT_HELD", "disabling the slot", () =>
      setSlotDisabled({ actor, slotId: slot.id, reason: "DoD: must be refused while held", enabled: false }),
    );
    console.log(`[1] seat/hold guard : time edit refused (${timeEditMsg}) | disable refused (${disableMsg})`);
  } finally {
    // Clean-up runs even on failure: the hold first, then the appointment —
    // leaving a confirmed booking on a live slot is not "clean".
    if (holdId !== undefined) await prisma.seatHold.delete({ where: { id: holdId } });
    if (appointmentId !== undefined) await prisma.appointment.delete({ where: { id: appointmentId } });
  }

  /* ------------------------------------------------------------------ */
  /* 2. Capacity raise is allowed AND audited (decisions 3/4/8).          */
  /*    Restored afterwards, so the slot ends exactly as the seed left it. */
  /* ------------------------------------------------------------------ */

  const baseMax = slot.maxPatients;

  const raised = await updateSlot({
    actor,
    slotId: slot.id,
    patch: { maxPatients: baseMax + 1 },
    reason: "DoD: raising capacity must always be allowed and audited",
  });
  if (raised.maxPatients !== baseMax + 1) {
    console.error(`FAIL: capacity raise did not land. Expected ${baseMax + 1}, got ${raised.maxPatients}.`);
    process.exit(1);
  }

  // The §20 row must exist, must be for THIS slot, and must carry the
  // before/after snapshot of exactly the tunable that moved.
  const auditRow = await prisma.auditLog.findFirst({
    where: { action: "SLOT_CAPACITY_CHANGE", targetType: "slot", targetId: slot.id },
    orderBy: { createdAt: "desc" },
    select: { before: true, after: true, reason: true },
  });
  const beforeSnapshot = auditRow?.before as Prisma.InputJsonObject | undefined;
  const afterSnapshot = auditRow?.after as Prisma.InputJsonObject | undefined;
  if (
    !auditRow ||
    beforeSnapshot?.maxPatients !== baseMax ||
    afterSnapshot?.maxPatients !== baseMax + 1
  ) {
    console.error(`FAIL: no correct SLOT_CAPACITY_CHANGE audit row (before=${baseMax}, after=${baseMax + 1}).`);
    console.error("     latest row was:", JSON.stringify(auditRow));
    process.exit(1);
  }

  const restored = await updateSlot({
    actor,
    slotId: slot.id,
    patch: { maxPatients: baseMax },
    reason: "DoD: restoring the seed maxPatients",
  });
  if (restored.maxPatients !== baseMax) {
    console.error(`FAIL: capacity restore did not land. Expected ${baseMax}.`);
    process.exit(1);
  }
  console.log(`[2] capacity audit  : raise to ${baseMax + 1} audited (before=${String(beforeSnapshot?.maxPatients)}, after=${String(afterSnapshot?.maxPatients)}), restored to ${baseMax}`);

  /* ------------------------------------------------------------------ */
  /* 3. The create walls (decision 6) — nothing mutated here.             */
  /* ------------------------------------------------------------------ */

  await expectRejection("SLOT_OVERLAP", `creating the identical window on ${plannedDate}`, () =>
    createSlot({
      actor,
      doctorId: doctor.id,
      slotDate: plannedDate,
      startTime: slotStart,
      endTime: slotEnd,
      maxPatients: 12,
    }),
  );

  const horizonMax = enumerateDates(clinicLocalToday, clinic.bookingHorizonDays).at(-1)!;
  const beyond = oneDayLater(horizonMax);
  await expectRejection(
    "SLOT_OUTSIDE_HORIZON",
    `creating a slot on ${beyond} (outside the ${clinic.bookingHorizonDays}-day horizon)`,
    () =>
      createSlot({
        actor,
        doctorId: doctor.id,
        slotDate: beyond,
        startTime: "09:00",
        endTime: "10:00",
        maxPatients: 12,
      }),
  );
  console.log(`[3] create walls    : duplicate window refused | beyond-horizon refused (${beyond})`);

  console.log("DoD met: the seat-or-hold guard blocks time-edit and disable with 409 SLOT_HELD;");
  console.log("   a capacity raise is allowed and audited; manual create cannot duplicate or exceed the horizon.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });