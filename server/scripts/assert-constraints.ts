// Proves the Day 6 constraints actually EXIST — by trying to break each one and
// requiring the database to refuse.
//
//   npm run db:assert
//
// Why this script exists at all: a migration that applies cleanly is not
// evidence that a rule exists. `CREATE UNIQUE INDEX ... WHERE ...` can be
// generated, recorded and applied while the predicate silently does nothing —
// and for the partial indexes that would mean the double-booking guard is
// decorative. The only honest test is a write that must fail.
//
// Every attempt here is expected to FAIL. A test that passes because the write
// succeeded is a broken test, so each assertion is "the database rejected this,
// and it was the right constraint that rejected it" — matched on the constraint
// name, not merely on "some error happened". The wrong constraint rejecting a
// write would leave the intended one untested.
//
// Runs against the real local database and cleans up after itself. It is
// deliberately not part of `npm test`: that suite must never touch the database.

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { localDateTimeToUtc } from "../src/lib/time.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

/**
 * Runs `write` and requires it to be rejected by the named constraint.
 *
 * Matching on the constraint name is the whole point. Prisma surfaces a unique
 * violation as a generic "Unique constraint failed", so the name is recovered
 * from the driver's error message — which is brittle in principle, but it is
 * checked at runtime on every run of this script rather than assumed.
 */
async function assertRejectedBy(label: string, constraintName: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes(constraintName)) {
      passed += 1;
      console.log(`  PASS  ${label}\n        rejected by ${constraintName}`);
      return;
    }
    failures.push(`${label}: expected ${constraintName}, got: ${text.split("\n").slice(0, 4).join(" | ")}`);
    console.log(`  FAIL  ${label}\n        expected ${constraintName}, got a different error`);
    return;
  }

  failures.push(`${label}: the write SUCCEEDED — the constraint does not exist`);
  console.log(`  FAIL  ${label}\n        the write succeeded, so nothing is enforcing this rule`);
}

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Fixture. Deliberately minimal and idempotent: one patient, one doctor, one
// staff user, one slot. Everything created here is removed in the finally
// block, so the script leaves the database exactly as it found it.
// ---------------------------------------------------------------------------

const suffix = `day6assert-${process.pid}`;
const CLINIC_ZONE = "Asia/Kolkata";

const patientId = "00000000-0000-4000-8000-00000000d601";
const doctorId = "00000000-0000-4000-8000-00000000d602";
const staffId = "00000000-0000-4000-8000-00000000d603";
const slotId = "00000000-0000-4000-8000-00000000d604";
const otherSlotId = "00000000-0000-4000-8000-00000000d605";
// A second patient, needed to prove the hold rule is per-patient rather than a
// blanket one-hold-per-database rule.
const otherPatientId = "00000000-0000-4000-8000-00000000d606";

const allUserIds = [patientId, otherPatientId, doctorId, staffId];

async function cleanup(): Promise<void> {
  // Strictly child-before-parent, because every FK in this schema is Restrict —
  // which is itself part of what Day 5 locked in. Deleting a user before its
  // profile, or a slot before its appointments, is rejected by the database.
  await prisma.notification.deleteMany({ where: { recipient: { startsWith: suffix } } });
  await prisma.seatHold.deleteMany({ where: { patientId: { in: [patientId, otherPatientId] } } });
  await prisma.payment.deleteMany({ where: { patientId: { in: [patientId, otherPatientId] } } });
  await prisma.appointment.deleteMany({ where: { patientId: { in: [patientId, otherPatientId] } } });
  await prisma.slot.deleteMany({ where: { id: { in: [slotId, otherSlotId] } } });
  await prisma.patientProfile.deleteMany({ where: { userId: { in: [patientId, otherPatientId] } } });
  await prisma.doctorProfile.deleteMany({ where: { userId: doctorId } });
  await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
}

async function seedFixtures(): Promise<void> {
  await cleanup();

  await prisma.user.createMany({
    data: [
      { id: patientId, role: "PATIENT", fullName: `Assert Patient ${suffix}`, email: `${suffix}-patient@example.test` },
      { id: doctorId, role: "DOCTOR", fullName: `Assert Doctor ${suffix}`, email: `${suffix}-doctor@example.test` },
      { id: staffId, role: "STAFF", fullName: `Assert Staff ${suffix}`, email: `${suffix}-staff@example.test` },
    ],
  });

  await prisma.patientProfile.create({ data: { userId: patientId, phone: `+9190000${suffix.slice(-4)}` } });

  // startAt/endAt are written through the single conversion helper, exactly as
  // the real slot generator must do. 2026-10-05 is a Monday.
  const startAt = localDateTimeToUtc({ date: "2026-10-05", time: "09:00" }, CLINIC_ZONE);
  const endAt = localDateTimeToUtc({ date: "2026-10-05", time: "12:00" }, CLINIC_ZONE);
  const startTime = new Date(Date.UTC(1970, 0, 1, 9, 0, 0));
  const endTime = new Date(Date.UTC(1970, 0, 1, 12, 0, 0));

  await prisma.slot.createMany({
    data: [
      {
        id: slotId,
        doctorId,
        slotDate: new Date(Date.UTC(2026, 9, 5)),
        startTime,
        endTime,
        startAt,
        endAt,
        maxPatients: 2,
      },
      {
        id: otherSlotId,
        doctorId,
        slotDate: new Date(Date.UTC(2026, 9, 6)),
        startTime,
        endTime,
        startAt: localDateTimeToUtc({ date: "2026-10-06", time: "09:00" }, CLINIC_ZONE),
        endAt: localDateTimeToUtc({ date: "2026-10-06", time: "12:00" }, CLINIC_ZONE),
        maxPatients: 2,
      },
    ],
  });
}

async function seedSecondPatient(): Promise<void> {
  await prisma.user.create({
    data: {
      id: otherPatientId,
      role: "PATIENT",
      fullName: `Assert Patient2 ${suffix}`,
      email: `${suffix}-patient2@example.test`,
    },
  });
  await prisma.patientProfile.create({ data: { userId: otherPatientId, phone: `+9191111${suffix.slice(-4)}` } });
}

function appointmentData(slot: string, feeAmount: number) {
  return {
    doctorId,
    patientId,
    slotId: slot,
    doctorName: `Assert Doctor ${suffix}`,
    feeAmount,
  };
}

function holdData(slot: string, orderSuffix: string) {
  return {
    slotId: slot,
    patientId,
    paymentOrderId: `order_${suffix}_${orderSuffix}`,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let appointmentOne: string | undefined;
let appointmentTwo: string | undefined;
let secondHoldId: string | undefined;

try {
  console.log(`Day 6 constraint assertions`);
  console.log(`  cwd ${serverRoot}`);
  console.log(`  zone ${CLINIC_ZONE}`);

  await seedFixtures();
  await seedSecondPatient();

  // -------------------------------------------------------------------------
  section("§15 double-booking guard — one active booking per patient per slot");
  // -------------------------------------------------------------------------

  appointmentOne = (
    await prisma.appointment.create({ data: { ...appointmentData(slotId, 50000), status: "CONFIRMED" } })
  ).id;

  await assertRejectedBy(
    "a SECOND CONFIRMED booking by the same patient in the same slot",
    "appointments_active_booking_per_patient_slot_unique",
    () => prisma.appointment.create({ data: { ...appointmentData(slotId, 50000), status: "CONFIRMED" } }),
  );

  await assertRejectedBy(
    "a second ARRIVED booking by the same patient in the same slot",
    "appointments_active_booking_per_patient_slot_unique",
    () => prisma.appointment.create({ data: { ...appointmentData(slotId, 50000), status: "ARRIVED" } }),
  );

  // The guard is PARTIAL: a released seat must not block a rebooking. If this
  // assertion ever fails, the index has become a plain unique constraint and
  // patients can never book the same slot twice in their lives.
  appointmentTwo = (
    await prisma.appointment.create({ data: { ...appointmentData(otherSlotId, 50000), status: "CONFIRMED" } })
  ).id;
  await prisma.appointment.update({ where: { id: appointmentTwo }, data: { status: "CANCELLED" } });

  const rebook = await prisma.appointment.create({
    data: { ...appointmentData(otherSlotId, 50000), status: "CONFIRMED" },
  });
  assert(rebook !== null, "the same patient CAN rebook a slot after cancelling (the index is partial, not total)");
  await prisma.appointment.delete({ where: { id: rebook.id } });

  // -------------------------------------------------------------------------
  section("§8.6 one live hold per patient");
  // -------------------------------------------------------------------------

  await prisma.seatHold.create({ data: holdData(otherSlotId, "a") });

  await assertRejectedBy(
    "a second live hold by the same patient on a DIFFERENT slot",
    "seat_holds_one_live_hold_per_patient_unique",
    () => prisma.seatHold.create({ data: holdData(slotId, "b") }),
  );

  // The released hold must not constrain anything: release the first hold and
  // confirm a new one is accepted.
  await prisma.seatHold.updateMany({
    where: { patientId },
    data: { releasedAt: new Date(), releaseReason: "ABANDONED" },
  });
  secondHoldId = (await prisma.seatHold.create({ data: holdData(slotId, "c") })).id;
  assert(secondHoldId !== undefined, "a released hold does not block a new hold (released_at IS NULL is the predicate)");
  await prisma.seatHold.delete({ where: { id: secondHoldId } });
  secondHoldId = undefined;

  // -------------------------------------------------------------------------
  section("§18 once-only reminder per (appointment, slot)");
  // -------------------------------------------------------------------------

  const notifyRef = appointmentOne;
  if (notifyRef === undefined) {
    failures.push("§18 reminder checks could not run: the §15 fixture appointment was never created");
  } else {
    const recipient = `${suffix}-patient@example.test`;

    await prisma.notification.create({ data: { type: "REMINDER", recipient, appointmentId: notifyRef, slotId } });

    await assertRejectedBy(
      "a second REMINDER for the same appointment and slot",
      "notifications_reminder_once_per_appointment_slot_unique",
      () => prisma.notification.create({ data: { type: "REMINDER", recipient, appointmentId: notifyRef, slotId } }),
    );

    // The reminder index is partial on TYPE, so another event for the same
    // appointment must still be insertable.
    const cancelled = await prisma.notification.create({
      data: { type: "APPOINTMENT_CANCELLED", recipient, appointmentId: notifyRef, slotId },
    });
    assert(cancelled !== null, "a non-REMINDER notification for the same appointment is still allowed");
    await prisma.notification.delete({ where: { id: cancelled.id } });
  }

  // -------------------------------------------------------------------------
  section("§8.1 / §15 slot capacity CHECKs");
  // -------------------------------------------------------------------------

  await assertRejectedBy(
    "setting booked_count above max_patients",
    "slots_capacity_check",
    () => prisma.slot.update({ where: { id: slotId }, data: { bookedCount: 3, maxPatients: 2 } }),
  );

  await assertRejectedBy(
    "counting booked + held past the capacity",
    "slots_capacity_check",
    () => prisma.slot.update({ where: { id: slotId }, data: { bookedCount: 1, heldCount: 2 } }),
  );

  await assertRejectedBy(
    "a slot with max_patients = 0",
    "slots_max_patients_positive_check",
    () => prisma.slot.update({ where: { id: slotId }, data: { maxPatients: 0 } }),
  );

  // The capacity CHECK is about the SUM, so filling a slot exactly to capacity
  // must be allowed. A <= bug here would be invisible until production.
  await prisma.slot.update({ where: { id: slotId }, data: { bookedCount: 2, heldCount: 0, maxPatients: 2 } });
  const exact = await prisma.slot.findUniqueOrThrow({ where: { id: slotId } });
  assert(
    exact.bookedCount + exact.heldCount === exact.maxPatients,
    "a slot filled exactly to capacity is allowed (the CHECK is <=, not <)",
  );

  // -------------------------------------------------------------------------
  section("§17 payment amount CHECK");
  // -------------------------------------------------------------------------

  // appointmentOne is created earlier in this script; checking it here keeps a
  // failed §15 from surfacing as a confusing foreign-key error in this section.
  const appointmentRef = appointmentOne;
  if (appointmentRef === undefined) {
    failures.push("§17 payment checks could not run: the §15 fixture appointment was never created");
  } else {
    await assertRejectedBy(
      "a payment of zero paise",
      "payments_amount_paise_positive_check",
      () =>
        prisma.payment.create({
          data: { patientId, appointmentId: appointmentRef, amountPaise: 0, method: "CASH" },
        }),
    );

    await assertRejectedBy(
      "a negative payment amount",
      "payments_amount_paise_positive_check",
      () =>
        prisma.payment.create({
          data: { patientId, appointmentId: appointmentRef, amountPaise: -1, method: "CASH" },
        }),
    );

    // A hold's order has NO appointment yet (§17), so the CHECK must be provable
    // on a payment that is not attached to one. If this fails, the constraint is
    // accidentally depending on a nullable column.
    await assertRejectedBy(
      "a zero-paise payment with no appointment (the §17 hold order shape)",
      "payments_amount_paise_positive_check",
      () => prisma.payment.create({ data: { patientId, amountPaise: 0 } }),
    );

    const paid = await prisma.payment.create({
      data: { patientId, appointmentId: appointmentRef, amountPaise: 1, method: "CASH", status: "PAID" },
    });
    assert(paid.amountPaise === 1, "a payment of one paise is allowed (the CHECK is > 0, not >= 1)");
  }

  // -------------------------------------------------------------------------
  section("§3.2 / §8.1 derived instants — start_at must match the wall clock");
  // -------------------------------------------------------------------------

  // The zone comes from whichever is authoritative at runtime: a seeded Clinic
  // row if one exists, else APP_TIMEZONE, else the fixture zone this script
  // already wrote its own slots with. Defaulting to Asia/Kolkata would make the
  // assertion pass on a machine whose clinic is somewhere else, which is exactly
  // the bug §3.2 exists to prevent.
  const clinic = await prisma.clinic.findFirst();
  const zone = clinic?.timezone ?? process.env.APP_TIMEZONE ?? CLINIC_ZONE;

  const slots = await prisma.slot.findMany();
  const mismatches: string[] = [];

  for (const slot of slots) {
    // start_time is a @db.Time, which pg returns as a timestamp on 1970-01-01.
    const date = slot.slotDate.toISOString().slice(0, 10);
    const time = slot.startTime.toISOString().slice(11, 16);
    const expectedStart = localDateTimeToUtc({ date, time }, zone);
    const expectedEnd = localDateTimeToUtc({ date, time: slot.endTime.toISOString().slice(11, 16) }, zone);

    if (expectedStart.getTime() !== slot.startAt.getTime()) {
      mismatches.push(
        `${slot.id} start: wall ${date} ${time} in ${zone} is ${expectedStart.toISOString()}, stored ${slot.startAt.toISOString()}`,
      );
    }
    if (expectedEnd.getTime() !== slot.endAt.getTime()) {
      mismatches.push(
        `${slot.id} end: wall ${date} ${slot.endTime.toISOString().slice(11, 16)} in ${zone} is ${expectedEnd.toISOString()}, stored ${slot.endAt.toISOString()}`,
      );
    }
  }

  assert(
    mismatches.length === 0,
    `every slot's start_at/end_at == toUtc(slot_date, start_time, ${zone}) across ${slots.length} slot(s)`,
    mismatches.join("; "),
  );

  // The assertion above can only be meaningful if it is capable of failing. A
  // hand-set start_at that disagrees with the wall clock must be detected.
  const probeSlot = await prisma.slot.findFirstOrThrow({ where: { id: slotId } });
  const probeDate = probeSlot.slotDate.toISOString().slice(0, 10);
  const probeTime = probeSlot.startTime.toISOString().slice(11, 16);
  const wrongInstant = new Date(localDateTimeToUtc({ date: probeDate, time: probeTime }, zone).getTime() + 3_600_000);
  assert(
    wrongInstant.getTime() !== probeSlot.startAt.getTime(),
    "the derived-instant check is non-vacuous (a deliberately shifted instant differs)",
  );
  await prisma.slot.update({ where: { id: slotId }, data: { startAt: wrongInstant } });
  const probeAfter = await prisma.slot.findUniqueOrThrow({ where: { id: slotId } });
  assert(
    probeAfter.startAt.getTime() !== localDateTimeToUtc({ date: probeDate, time: probeTime }, zone).getTime(),
    "a slot with a deliberately wrong start_at IS detectable (the check above would catch it)",
    "the database refused or hid the bad instant, so the invariant is unverifiable",
  );
  // Restore, so the script leaves no bad data behind even if it exits oddly.
  await prisma.slot.update({ where: { id: slotId }, data: { startAt: probeSlot.startAt } });

  // -------------------------------------------------------------------------
  section("§20 the shared actor block — actor_name is NOT NULL");
  // -------------------------------------------------------------------------

  // Deliberately raw SQL rather than prisma.auditLog.create: TypeScript already
  // rejects this at compile time because actorName is required, so an ORM call
  // would never reach the database and the NOT NULL would go untested. Raw SQL
  // is the only way to prove the column itself is NOT NULL.
  //
  // actorName is the one non-nullable field in the shared actor block, and it is
  // non-nullable precisely so §5.1/§5.2 attribution survives a later rename or
  // deactivation of the actor.
  await assertRejectedBy(
    "an audit row with no actor name",
    "actor_name",
    () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, action, target_type, target_id, actor_name, created_at)
         VALUES (gen_random_uuid(), 'ASSERT_TEST', 'slot', $1, NULL, now())`,
        slotId,
      ),
  );

  await assertRejectedBy(
    "an appointment_history row with no actor name",
    "actor_name",
    () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO appointment_histories (id, appointment_id, event_type, actor_name, created_at)
         VALUES (gen_random_uuid(), $1, 'BOOKED', NULL, now())`,
        appointmentRef ?? slotId,
      ),
  );

  // The nullable half: a scheduled job has no User, and that must remain
  // possible. §12's auto-cancel and §8.6's hold expiry are recorded with
  // actorName = 'system' and everything else null — if actorId/actorRole were
  // required, the system could never write an audit row at all.
  const systemRow = await prisma.$queryRawUnsafe<{ actor_name: string | null; actor_id: string | null }[]>(
    `INSERT INTO audit_logs (id, action, target_type, target_id, actor_name, actor_id, actor_role, created_at)
     VALUES (gen_random_uuid(), 'ASSERT_TEST', 'slot', $1, 'system', NULL, NULL, now())
     RETURNING actor_name, actor_id`,
    slotId,
  );
  assert(
    systemRow[0]?.actor_name === "system" && systemRow[0]?.actor_id === null,
    "a SYSTEM audit row (no actor_id, no role, name 'system') is accepted — the discriminator works",
  );
  await prisma.auditLog.deleteMany({ where: { action: "ASSERT_TEST" } });

  // -------------------------------------------------------------------------
  section("§20 audit log is append-only by convention — no updatedAt column");
  // -------------------------------------------------------------------------

  const auditHasUpdatedAt = await prisma.$queryRawUnsafe<{ column_name: string }[]>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'updated_at'
  `);
  assert(
    auditHasUpdatedAt.length === 0,
    "audit_logs has NO updated_at column, so @updatedAt cannot make history rows mutable",
    auditHasUpdatedAt.length > 0 ? "updated_at exists, which means an audit row can be silently rewritten" : undefined,
  );
} catch (error) {
  failures.push(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`\nUnexpected error:\n${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup();
  await prisma.$disconnect();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${passed} ASSERTIONS PASSED`);
  console.log("Every constraint above is present and enforced by the database.");
  await prisma.$disconnect();
  process.exit(0);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log("\nA constraint that is not enforced here is not enforced at all.");
  await prisma.$disconnect();
  process.exit(1);
}