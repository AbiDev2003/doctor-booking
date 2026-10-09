import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { config } from "../src/config.js";
import { clinicDayRange, formatInClinicTime } from "../src/lib/time.js";

/**
 * Day 14 demo: put today's queue on the seeded doctors' desks.
 *
 * The §28 queue is real data only — a doctor with no appointments sees an empty
 * state by design, and that is correct behaviour, not a gap. This script is the
 * optional shim (D12 option B) that creates a realistic queue in a seeded local
 * database so Day 14's UI has something to render. It is deliberately a demo
 * and nothing more:
 *
 * - it writes only CONFIRMED appointments in the same transaction that bumps
 *   the slot's stored `bookedCount` (§8.1) — the counter is authoritative and
 *   must never drift from the rows;
 * - it is idempotent: re-running books nothing twice and only tops up missing
 *   combos, so it is safe to re-run after a day-rollover or a reset;
 * - a day with no seeded slots (the week template has no Sunday) or no bookable
 *   doctor is a clean message, not a partial write.
 *
 * It does NOT touch slots, schedules, holds or cancellations — Phase 4 owns
 * those flows, and this shim exists to demonstrate the read side only.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

async function main(): Promise<void> {
  const now = new Date();

  // §3.2 (Day 15 decision 4): Clinic.timezone is the runtime authority; the
  // APP_TIMEZONE fallback only covers a clinic row that never got seeded.
  const clinicRow = await prisma.clinic.findFirst({ select: { timezone: true } });
  const ZONE = clinicRow?.timezone ?? config.APP_TIMEZONE;
  const range = clinicDayRange(now, ZONE);
  const today = formatInClinicTime(range.start, ZONE).slice(0, 10);

  // The doctor to book: the bookable (§5) one with the earliest window today,
  // so the logged-in demo doctor is deterministic and has something to see.
  const doctor = await prisma.user.findFirst({
    where: {
      role: "DOCTOR",
      doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null },
      slots: { some: { startAt: { gte: range.start, lt: range.endExclusive } } },
    },
    select: {
      id: true,
      fullName: true,
      doctorProfile: { select: { consultationFee: true } },
      slots: {
        where: { startAt: { gte: range.start, lt: range.endExclusive } },
        orderBy: { startAt: "asc" },
        take: 1,
        select: { id: true, startTime: true, endTime: true },
      },
    },
  });

  if (!doctor?.slots[0]) {
    console.log(
      `No bookable doctor has a slot today (${today}).\n` +
        "  The seed's week template has no Sunday and generation is provisional " +
        "until Day 15; re-run on a weekday after `db:seed`.",
    );
    return;
  }

  const clinic = await prisma.clinic.findFirst({ select: { defaultConsultationFee: true } });
  const fee = doctor.doctorProfile?.consultationFee ?? clinic?.defaultConsultationFee ?? 50_000;

  // The two seeded patients — the shape of this query is the same create-or-find
  // by phone §16 uses, only here the patients must already exist.
  const patients = await prisma.user.findMany({
    where: { role: "PATIENT", patientProfile: { not: null } },
    select: { id: true, fullName: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });

  if (patients.length === 0) {
    console.log("No patient accounts found. Run `db:seed` (which needs SEED_PATIENT_PASSWORD) first.");
    return;
  }

  const slot = doctor.slots[0];

  // Idempotency: a patient who already holds this seat today is left alone. The
  // §15 partial-unique guard would reject a duplicate anyway; the check just
  // turns that loud error into a "nothing to do".
  const existing = await prisma.appointment.findMany({
    where: {
      slotId: slot.id,
      status: { in: ["CONFIRMED", "ARRIVED"] },
    },
    select: { patientId: true },
  });
  const alreadyBooked = new Set(existing.map((a) => a.patientId));

  const fresh = patients.filter((p) => !alreadyBooked.has(p.id));
  if (fresh.length === 0) {
    console.log(`Nothing to do: the ${today} queue already holds a seat for every seeded patient.`);
    return;
  }

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const patient of fresh) {
      const appointment = await tx.appointment.create({
        data: {
          doctorId: doctor.id,
          doctorName: doctor.fullName,
          patientId: patient.id,
          slotId: slot.id,
          feeAmount: fee,
        },
        select: { id: true, bookingTime: true },
      });
      rows.push({ ...appointment, patientName: patient.fullName });
    }
    await tx.slot.update({
      where: { id: slot.id },
      data: { bookedCount: { increment: rows.length } },
    });
    return rows;
  });

  console.log(`Queued ${created.length} booking${created.length === 1 ? "" : "s"} for ${doctor.fullName} on ${today} in ${ZONE}`);
  for (const row of created) {
    console.log(`  - ${row.patientName} → ${row.id}`);
  }
  console.log(`Slot window: ${slot.startTime.toISOString().slice(11, 16)}–${slot.endTime.toISOString().slice(11, 16)}  bookedCount now += ${created.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });