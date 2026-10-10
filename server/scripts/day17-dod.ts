// Day 17 DoD against the real local database:
//
//   npx tsx scripts/day17-dod.ts
//
// Proves, through the actual read model (`listDoctorAvailability`), that the
// public storefront shows exactly the slots a patient could book and nothing
// else. Each condition is set up directly in the database (a disabled flag, a
// full counter, a disruption row, a suspension) because the write paths that
// would normally create them — booking, unavailability CRUD — are Days 18/19;
// the READ side is what Day 17 owns.
//
//   1. BASELINE: a future doctor-day lists at least one bookable slot.
//   2. A DISABLED slot disappears (§8.4) and returns when re-enabled.
//   3. A FULL slot disappears (§8.1) and returns when a seat frees.
//   4. A slot overlapped by a DoctorUnavailability disappears (§11/§12) and
//      returns when the disruption is removed.
//   5. A SUSPENDED doctor answers 404 DOCTOR_NOT_FOUND, not an empty list.
//   6. A date OUTSIDE the horizon answers an EMPTY list (locked decision 6),
//      both before today and past the far edge.
//
// Clean-up: every mutation is reverted in a `finally`; only the disruption row
// it created is added then removed, so the database ends as it started (a
// re-seed resets everything regardless).

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { enumerateDates, weekdayOfDate } from "../src/lib/slotPlan.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { AppError } from "../src/lib/appError.js";
import { listDoctorAvailability } from "../src/services/availability.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

function addDays(date: string, days: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month, day + days)).toISOString().slice(0, 10);
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findUnique({ where: { id: "0c000000-0000-4000-8000-000000000001" } });
  if (!clinic) fail("No clinic row. Run the seed first (npm run db:seed).");

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  if (!admin) fail("No ADMIN user. Run the seed first (npm run db:seed).");

  const doctor = await prisma.user.findFirst({
    where: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    select: { id: true, fullName: true },
  });
  if (!doctor) fail("No VERIFIED doctor. Run the seed first (npm run db:seed).");

  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;
  const horizonMax = addDays(today, clinic.bookingHorizonDays);

  const windows = await prisma.schedule.findMany({
    where: { doctorId: doctor.id },
    select: { weekday: true },
  });
  if (windows.length === 0) fail("The doctor has no schedule windows. Re-seed and retry.");

  // A FUTURE date inside the horizon (never today: today's windows may already
  // have elapsed, which would legitimately empty the baseline).
  const plannedDate = enumerateDates(today, clinic.bookingHorizonDays).find(
    (date) => date !== today && windows.some((w) => w.weekday === weekdayOfDate(date)),
  );
  if (!plannedDate) fail("No future planned slot date within the horizon for the doctor.");

  console.log(`clinic        : ${clinic.name} (${clinic.timezone}, horizon ${clinic.bookingHorizonDays}d)`);
  console.log(`doctor        : ${doctor.fullName} (${doctor.id})`);
  console.log(`target date   : ${plannedDate}`);

  /* ------------------------------------------------------------------ */
  /* 1. Baseline: at least one bookable slot on the chosen day.          */
  /* ------------------------------------------------------------------ */

  const baseline = await listDoctorAvailability(doctor.id, plannedDate);
  if (baseline.length === 0) fail(`Baseline listed no bookable slots on ${plannedDate} (expected at least one).`);
  const targetId = baseline[0]!.slotId;
  console.log(`[1] baseline       : ${baseline.length} bookable slot(s); first ${baseline[0]!.startTime}–${baseline[0]!.endTime}`);

  const slot = await prisma.slot.findUnique({
    where: { id: targetId },
    select: { id: true, startAt: true, endAt: true, maxPatients: true, bookedCount: true, heldCount: true, isDisabled: true },
  });
  if (!slot) fail("The listed slot vanished before it could be inspected.");

  /* ------------------------------------------------------------------ */
  /* 2. A disabled slot is hidden (§8.4).                                 */
  /* ------------------------------------------------------------------ */

  try {
    await prisma.slot.update({ where: { id: targetId }, data: { isDisabled: true, disabledReason: "DoD" } });
    const after = await listDoctorAvailability(doctor.id, plannedDate);
    if (after.some((s) => s.slotId === targetId)) fail("A DISABLED slot was still listed.");
  } finally {
    await prisma.slot.update({ where: { id: targetId }, data: { isDisabled: false, disabledReason: null } });
  }
  console.log("[2] disabled hide  : slot removed from the list, restored on re-enable");

  /* ------------------------------------------------------------------ */
  /* 3. A full slot is hidden (§8.1).                                     */
  /* ------------------------------------------------------------------ */

  try {
    await prisma.slot.update({
      where: { id: targetId },
      data: { bookedCount: slot.maxPatients - slot.heldCount },
    });
    const after = await listDoctorAvailability(doctor.id, plannedDate);
    if (after.some((s) => s.slotId === targetId)) fail("A FULL slot was still listed.");
  } finally {
    await prisma.slot.update({ where: { id: targetId }, data: { bookedCount: slot.bookedCount } });
  }
  console.log("[3] full hide      : slot removed from the list, restored when a seat frees");

  /* ------------------------------------------------------------------ */
  /* 4. A slot overlapping a disruption is hidden (§11/§12).              */
  /* ------------------------------------------------------------------ */

  let disruptionId: string | undefined;
  try {
    const disruption = await prisma.doctorUnavailability.create({
      data: {
        doctorId: doctor.id,
        createdById: admin.id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        reason: "DoD synthetic disruption",
      },
    });
    disruptionId = disruption.id;
    const after = await listDoctorAvailability(doctor.id, plannedDate);
    if (after.some((s) => s.slotId === targetId)) fail("A slot overlapping a disruption was still listed.");
  } finally {
    if (disruptionId !== undefined) await prisma.doctorUnavailability.delete({ where: { id: disruptionId } });
  }
  console.log("[4] disruption hide: slot removed while overlapped, restored when the disruption is deleted");

  /* ------------------------------------------------------------------ */
  /* 5. A suspended doctor answers 404, not an empty list.                */
  /* ------------------------------------------------------------------ */

  try {
    await prisma.doctorProfile.update({ where: { userId: doctor.id }, data: { suspendedAt: new Date() } });
    let code = "";
    try {
      await listDoctorAvailability(doctor.id, plannedDate);
    } catch (err) {
      if (err instanceof AppError) code = err.code;
      else fail(`Suspended doctor threw a non-AppError: ${String(err)}`);
    }
    if (code !== "DOCTOR_NOT_FOUND") fail(`Suspended doctor answered ${code || "success"}, expected DOCTOR_NOT_FOUND.`);
  } finally {
    await prisma.doctorProfile.update({ where: { userId: doctor.id }, data: { suspendedAt: null } });
  }
  console.log("[5] suspension     : hidden doctor answers 404 DOCTOR_NOT_FOUND, restored");

  /* ------------------------------------------------------------------ */
  /* 6. Dates outside the horizon answer an empty list (decision 6).      */
  /* ------------------------------------------------------------------ */

  const beforeToday = addDays(today, -1);
  const pastHorizon = addDays(horizonMax, 1);
  const beforeResult = await listDoctorAvailability(doctor.id, beforeToday);
  const pastResult = await listDoctorAvailability(doctor.id, pastHorizon);
  if (beforeResult.length !== 0) fail(`A date before today (${beforeToday}) returned ${beforeResult.length} slot(s).`);
  if (pastResult.length !== 0) fail(`A date past the horizon (${pastHorizon}) returned ${pastResult.length} slot(s).`);
  console.log(`[6] horizon edges  : ${beforeToday} and ${pastHorizon} both answered []`);

  console.log("DoD met: the public read model shows only bookable slots — hiding disabled, full and");
  console.log("   overlap-disrupted slots, 404-ing a suspended doctor, and emptying out-of-horizon days.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
