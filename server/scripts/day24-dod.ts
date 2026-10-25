// Day 24 DoD against the real local database AND the real Razorpay TEST API:
//
//   npx tsx scripts/day24-dod.ts
//
// Proves §17's second half — the seat hold and the conversion into a booking —
// through the real services, not just the pure layer, which `npm test` covers:
//
//   1. HOLD BEFORE MONEY. A verified patient starts an order for a fixture
//      slot: the SeatHold and the PENDING Payment land in one transaction
//      BEFORE the gateway is asked for anything — held_count claims exactly one
//      seat, the hold's expiresAt is min(now + clinic.holdDurationMinutes,
//      slot.startAt) (here the former; the slot sits 48h out), and the hold's
//      paymentOrderId and the payment's orderId are linked to the SAME
//      `order_…` (both ids or neither, §8.6 step 5).
//   2. THE CONVERSION. The gateway's triple is faked the way §17 step 4 allows
//      (decision B3: no gateway re-fetch of `pay_…` — the script computes the
//      HMAC locally over `order_id|fabricated_pay_id` with the TEST key
//      secret, the identical construction `POST /payments/verify` checks).
//      `convertPayment` then, in ONE transaction: moves held→booked on the
//      slot, creates the appointment CONFIRMED with feeAmount = the PAID
//      amount, flips hold→CONVERTED and payment→PAID (stamped with the pay id
//      and paidAt), and writes the BOOKED history + APPOINTMENT_BOOKED +
//      PAYMENT_PAID audits.
//   3. IDEMPOTENT REPLAY. The same triple again returns the SAME appointment
//      with ZERO further writes (§17: verify + webhook double-delivery
//      converge), and another patient's id against this order is a 404 that
//      reveals nothing.
//   4. THE REFUSALS, each leaving the payment PENDING (money-first rules:
//      nothing is half-marked) — an expired hold → 409 HOLD_EXPIRED with the
//      counters untouched; a full slot (maxPatients 1, one seat already held)
//      → 409 SLOT_FULL before any row exists; the same patient re-ordering an
//      already-booked slot → 409 ALREADY_BOOKED before money; a second
//      checkout abandoning the first → the old hold released ABANDONED with
//      its held_count handed back.
//
// NOT exercised here: the route-level signature REJECTION (pure-tested in
// tests/paymentSignature.test.ts), the raw-body webhook wiring (app.ts —
// manual), and §17 step 4's re-fetch of `pay_…` from the gateway (decision B3:
// fabricated id, locally computed signature — noted in the Day 24 decisions
// table). The standing MANUAL DoD is one real test-card payment through the
// browser, which exercises all of it at once.
//
// SKIPS (banner + exit 0) when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are
// absent from server/.env: every scenario starts with a real gateway order.
// The keys-free pure layer still passed via `npm test`.
//
// FIXTURES: its OWN verified doctor, slots and patients (prefix day24-), so
// neither a generated schedule nor seeded patients are read-and-written.
// Everything it creates is removed in a `finally` (and a stale-run purge runs
// first), so the database ends as it started. The TEST orders are uncaptured:
// nothing to clean at the gateway.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { $Enums, PrismaClient } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { deriveConsultationFee } from "../src/lib/fee.js";
import { utcToLocalDateTime } from "../src/lib/time.js";
import { computePaymentSignature } from "../src/lib/paymentSignature.js";
import { createPaymentOrder } from "../src/services/paymentOrder.service.js";
import { convertPayment } from "../src/services/paymentConvert.service.js";
import { getClinicSettings } from "../src/services/clinic.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
if (!KEY_ID || !KEY_SECRET) {
  console.error("===============================================================");
  console.error("SKIP: Day 24 DoD needs RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.");
  console.error("Paste test-mode keys into server/.env and re-run.");
  console.error("The keys-free pure layer still passed via `npm test`.");
  console.error("===============================================================");
  process.exit(0);
}
// Declared type, not just narrowed: the gate above proves it, and `main` is a
// separate function the narrowing does not travel into.
const SIGNING_SECRET: string = KEY_SECRET;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const FIXTURE_EMAIL_PREFIX = "day24-";
const HOLD_DURATION_NOTE = "§8.6 hold duration comes from clinic.holdDurationMinutes (no config constant)";

function fail(message: string): never {
  // Throws rather than `process.exit` so the `finally` cleanup always runs.
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
  doctorIds: string[];
  slotIds: string[];
}

/**
 * Removes everything a run (crashed or not) created, in FK order:
 * history → holds → payments → audits → appointments → slots → profiles → users.
 */
async function removeFixtures(state: RunState): Promise<void> {
  const userIds = [...state.patientIds, ...state.doctorIds];
  if (userIds.length === 0 && state.slotIds.length === 0) return;

  const appointments = await prisma.appointment.findMany({
    where: { patientId: { in: state.patientIds } },
    select: { id: true },
  });
  const appointmentIds = appointments.map((row) => row.id);

  await prisma.appointmentHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } });
  await prisma.seatHold.deleteMany({ where: { patientId: { in: state.patientIds } } });
  await prisma.payment.deleteMany({ where: { patientId: { in: state.patientIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await prisma.slot.deleteMany({ where: { id: { in: state.slotIds } } });
  await prisma.doctorProfile.deleteMany({ where: { userId: { in: state.doctorIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

/** Removes fixtures a previous crashed run left behind (the day22/23 bargain). */
async function purgeStaleFixtures(): Promise<number> {
  const staleUsers = await prisma.user.findMany({
    where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } },
    select: { id: true, role: true },
  });
  if (staleUsers.length === 0) return 0;

  const doctorIds = staleUsers.filter((row) => row.role === $Enums.UserRole.DOCTOR).map((row) => row.id);
  const patientIds = staleUsers.filter((row) => row.role === $Enums.UserRole.PATIENT).map((row) => row.id);
  const staleSlots = await prisma.slot.findMany({ where: { doctorId: { in: doctorIds } }, select: { id: true } });

  await removeFixtures({ patientIds, doctorIds, slotIds: staleSlots.map((row) => row.id) });
  return staleUsers.length;
}

/** `@db.Time(0)` column value from an `HH:mm` wall-clock string. */
function timeValue(hhmm: string): Date {
  const [hour, minute] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0));
}

async function main(): Promise<void> {
  const clinic = await getClinicSettings();
  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log(`purged      : ${purged} stale fixture user(s) from a crashed run`);

  // The fixture window: 48h out — safely past minLeadMinutes, inside the
  // booking horizon, and far enough ahead that the hold's clamp-at-slot-start
  // never activates (so the expiry assertion below is the pure +duration case).
  const now = Date.now();
  if (clinic.minLeadMinutes >= 48 * 60) fail(`clinic.minLeadMinutes is ${clinic.minLeadMinutes} — 48h out would already be "started".`);
  if (clinic.bookingHorizonDays < 3) fail(`clinic.bookingHorizonDays is ${clinic.bookingHorizonDays} — the fixture window needs at least 3.`);

  const state: RunState = { patientIds: [], doctorIds: [], slotIds: [] };

  console.log(`clinic      : ${clinic.name} (${clinic.timezone}, hold ${clinic.holdDurationMinutes}m — ${HOLD_DURATION_NOTE})`);

  try {
    /* ---------------------------------------------------------------- */
    /* Fixture doctor + slots (own rows — seeded schedule is read-free).  */
    /* ---------------------------------------------------------------- */
    const doctor = await prisma.user.create({
      data: {
        role: "DOCTOR",
        fullName: "Day24 DoD doctor",
        email: `${FIXTURE_EMAIL_PREFIX}doctor-${process.pid}@example.test`,
        emailVerifiedAt: new Date(),
        doctorProfile: {
          create: { verificationStatus: "VERIFIED", consultationFee: 750 },
        },
      },
      select: { id: true },
    });
    state.doctorIds.push(doctor.id);

    async function createSlot(maxPatients: number, startOffsetHours: number): Promise<{ id: string; startAt: Date }> {
      // Distinct start per slot: the (doctor, slotDate, startTime) unique key
      // is a real constraint, and every scenario needs its own seat anyway.
      const startAt = new Date(now + (48 + startOffsetHours) * 3_600_000);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);
      const localStart = utcToLocalDateTime(startAt, clinic.timezone);
      const localEnd = utcToLocalDateTime(endAt, clinic.timezone);
      const slot = await prisma.slot.create({
        data: {
          doctorId: doctor.id,
          slotDate: new Date(`${localStart.date}T00:00:00.000Z`),
          startTime: timeValue(localStart.time),
          endTime: timeValue(localEnd.time),
          startAt,
          endAt,
          maxPatients,
        },
        select: { id: true, startAt: true },
      });
      state.slotIds.push(slot.id);
      return slot;
    }

    const slotA = await createSlot(3, 0); // hold + conversion + replay + same-slot
    const slotB = await createSlot(3, 1); // expired hold
    const slotC = await createSlot(1, 2); // the full-slot wall (one seat, one cap)
    const slotD = await createSlot(3, 3); // abandoned first checkout
    const slotE = await createSlot(3, 4); // the replacement checkout

    async function createPatient(label: string): Promise<ActorContext> {
      const patient = await prisma.user.create({
        data: {
          role: "PATIENT",
          fullName: `Day24 DoD ${label}`,
          email: `${FIXTURE_EMAIL_PREFIX}${label}-${process.pid}@example.test`,
          emailVerifiedAt: new Date(),
        },
        select: { id: true, fullName: true },
      });
      state.patientIds.push(patient.id);
      return { id: patient.id, role: $Enums.UserRole.PATIENT, name: patient.fullName };
    }

    const p1 = await createPatient("p1");
    const p2 = await createPatient("p2");
    const p3 = await createPatient("p3");
    const p4 = await createPatient("p4");

    const expectedFee = deriveConsultationFee(750, clinic.defaultConsultationFee);
    expect(expectedFee === 750, `fixture doctor's 750p fee should win the derivation, got ${expectedFee}p`);

    /* ---------------------------------------------------------------- */
    /* 1. HOLD BEFORE MONEY — seat claimed, rows linked, expiry from the  */
    /*    clinic's own setting.                                           */
    /* ---------------------------------------------------------------- */
    const order = await createPaymentOrder({ actor: p1, slotId: slotA.id, requestId: "day24-dod" });
    expect(order.amountPaise === expectedFee, `order amount ${order.amountPaise}p !== fixture fee ${expectedFee}p`);
    expect(order.orderId.startsWith("order_"), `gateway order id should start with "order_", got "${order.orderId}"`);
    expect(order.keyId === KEY_ID, "the DTO must carry the publishable keyId");

    const slotAfterOrder = await prisma.slot.findUnique({ where: { id: slotA.id }, select: { bookedCount: true, heldCount: true } });
    expect(slotAfterOrder?.heldCount === 1 && slotAfterOrder?.bookedCount === 0, "the hold claimed exactly one seat: held 0→1, booked untouched");

    const hold1 = await prisma.seatHold.findFirst({ where: { patientId: p1.id } });
    expect(hold1 !== null, "the SeatHold exists");
    if (!hold1) fail("unreachable: hold not found");
    expect(hold1.releasedAt === null, "the hold is live (unreleased)");
    expect(hold1.paymentOrderId === order.orderId, "the hold's paymentOrderId is the gateway order — conversion's lookup key");
    const expectedExpiry = hold1.createdAt.getTime() + clinic.holdDurationMinutes * 60_000;
    expect(
      Math.abs(hold1.expiresAt.getTime() - expectedExpiry) < 5_000 && hold1.expiresAt.getTime() < slotA.startAt.getTime(),
      `expiresAt should be createdAt + ${clinic.holdDurationMinutes}m (clamp inactive, slot is 48h out), got ${hold1.expiresAt.toISOString()}`,
    );

    const payment1 = await prisma.payment.findFirst({ where: { patientId: p1.id, orderId: order.orderId } });
    expect(payment1 !== null && payment1.status === $Enums.PaymentStatus.PENDING, "the Payment row is PENDING and linked");
    if (!payment1) fail("unreachable: payment not found");
    expect(payment1.appointmentId === null, "no appointment is attached — a hold is not a booking");
    const createdAudits = await prisma.auditLog.count({
      where: { action: "PAYMENT_ORDER_CREATED", targetType: "payment", targetId: payment1.id },
    });
    expect(createdAudits === 1, `expected exactly one PAYMENT_ORDER_CREATED audit, got ${createdAudits}`);
    console.log("hold        : seat held (1/0), expiry = createdAt + holdDuration, both ids linked, payment PENDING");

    /* ---------------------------------------------------------------- */
    /* 2. THE CONVERSION — locally computed §17 step-4 signature.         */
    /* ---------------------------------------------------------------- */
    const gatewayPaymentId = `pay_day24${process.pid}${Date.now().toString().slice(-6)}`;
    const signature = computePaymentSignature(SIGNING_SECRET, order.orderId, gatewayPaymentId);

    // What /payments/verify checks before calling this (pure-tested): a
    // 64-hex HMAC over `order_id|payment_id` with the KEY_SECRET. Decision B3:
    // no re-fetch of pay_… from the gateway — the id is fabricated here.
    expect(signature.length === 64 && /^[0-9a-f]+$/.test(signature), "the locally computed signature is 64 hex chars");

    const appointment = await convertPayment({
      orderId: order.orderId,
      gatewayPaymentId,
      expectedPatientId: p1.id,
      actor: p1,
      requestId: "day24-dod-convert",
    });
    expect(appointment.status === $Enums.AppointmentStatus.CONFIRMED, `appointment should be born CONFIRMED, is ${appointment.status}`);
    expect(appointment.feeAmount === expectedFee, `appointment.feeAmount ${appointment.feeAmount}p !== paid amount ${expectedFee}p`);
    expect(appointment.slotId === slotA.id, "the appointment sits on the held slot");

    const slotAfterConvert = await prisma.slot.findUnique({ where: { id: slotA.id }, select: { bookedCount: true, heldCount: true } });
    expect(
      slotAfterConvert?.heldCount === 0 && slotAfterConvert?.bookedCount === 1,
      "THE seat move: held 1→0, booked 0→1",
    );

    const holdAfter = await prisma.seatHold.findUnique({ where: { id: hold1.id } });
    expect(holdAfter?.releaseReason === $Enums.SeatHoldReleaseReason.CONVERTED, "hold released as CONVERTED");
    expect(holdAfter?.releasedAt !== null && holdAfter?.appointmentId === appointment.id, "hold points at the appointment it produced");

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment1.id } });
    expect(paymentAfter?.status === $Enums.PaymentStatus.PAID, "payment flipped PENDING→PAID");
    expect(paymentAfter?.paymentId === gatewayPaymentId && paymentAfter?.paidAt !== null, "payment stamped with the gateway pay id + paidAt");
    expect(paymentAfter?.appointmentId === appointment.id, "payment points at the appointment");

    const bookedEvents = await prisma.appointmentHistory.count({
      where: { appointmentId: appointment.id, eventType: $Enums.AppointmentEventType.BOOKED, toStatus: $Enums.AppointmentStatus.CONFIRMED },
    });
    expect(bookedEvents === 1, `expected exactly one BOOKED history row, got ${bookedEvents}`);
    const bookedAudit = await prisma.auditLog.count({ where: { action: "APPOINTMENT_BOOKED", targetId: appointment.id } });
    const paidAudit = await prisma.auditLog.count({ where: { action: "PAYMENT_PAID", targetId: payment1.id } });
    expect(bookedAudit === 1 && paidAudit === 1, `audits: APPOINTMENT_BOOKED ${bookedAudit}, PAYMENT_PAID ${paidAudit} (want 1 each)`);
    console.log("conversion  : appointment CONFIRMED, seat moved, hold CONVERTED, payment PAID, history + audits written");

    /* ---------------------------------------------------------------- */
    /* 3. IDEMPOTENT REPLAY + the wrong patient.                          */
    /* ---------------------------------------------------------------- */
    const appointmentsForP1 = async (): Promise<number> => prisma.appointment.count({ where: { patientId: p1.id } });

    const replay = await convertPayment({
      orderId: order.orderId,
      gatewayPaymentId: "a_completely_different_pay_id",
      expectedPatientId: p1.id,
      actor: p1,
      requestId: "day24-dod-replay",
    });
    expect(replay.id === appointment.id, "the replay returns the SAME appointment, not a second one");
    expect((await appointmentsForP1()) === 1, "still exactly one appointment after replay");
    const paidAuditAfterReplay = await prisma.auditLog.count({ where: { action: "PAYMENT_PAID", targetId: payment1.id } });
    const paymentRowAfterReplay = await prisma.payment.findUnique({ where: { id: payment1.id } });
    expect(paidAuditAfterReplay === 1, "the replay wrote zero new audit rows");
    expect(paymentRowAfterReplay?.paymentId === gatewayPaymentId, "the replay did not overwrite the stored gateway pay id");

    await expectRejection("PAYMENT_NOT_FOUND", "another patient verifying this order", () =>
      convertPayment({ orderId: order.orderId, gatewayPaymentId, expectedPatientId: p2.id, actor: p2 }),
    );
    console.log("replay       : same appointment, zero writes; wrong patient is a 404 that reveals nothing");

    /* ---------------------------------------------------------------- */
    /* 4. THE REFUSALS — each leaves the payment PENDING.                 */
    /* ---------------------------------------------------------------- */
    /* (a) Same slot, already booked: refused BEFORE money, no new row.   */
    const paymentsForP1Before = await prisma.payment.count({ where: { patientId: p1.id } });
    await expectRejection("ALREADY_BOOKED", "the same patient re-ordering a booked slot", () =>
      createPaymentOrder({ actor: p1, slotId: slotA.id, requestId: "day24-dod-same" }),
    );
    expect(
      (await prisma.payment.count({ where: { patientId: p1.id } })) === paymentsForP1Before,
      "the ALREADY_BOOKED refusal created no payment row",
    );

    /* (b) Expired hold: conversion refuses, nothing changes.             */
    const orderB = await createPaymentOrder({ actor: p2, slotId: slotB.id, requestId: "day24-dod-exp" });
    const holdB = await prisma.seatHold.findFirst({ where: { patientId: p2.id, paymentOrderId: orderB.orderId } });
    expect(holdB !== null, "the second hold exists");
    if (!holdB) fail("unreachable: hold B not found");
    await prisma.seatHold.update({ where: { id: holdB.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    await expectRejection("HOLD_EXPIRED", "converting an expired hold", () =>
      convertPayment({
        orderId: orderB.orderId,
        gatewayPaymentId: "pay_expired_scenario",
        expectedPatientId: p2.id,
        actor: p2,
      }),
    );
    const paymentB = await prisma.payment.findFirst({ where: { patientId: p2.id, orderId: orderB.orderId } });
    expect(paymentB?.status === $Enums.PaymentStatus.PENDING, "the refused payment stays PENDING (money-first: nothing half-marked)");
    const holdBAfter = await prisma.seatHold.findUnique({ where: { id: holdB.id } });
    expect(holdBAfter?.releasedAt === null, "the expired hold is not silently released by the failed conversion");
    expect(
      (await prisma.slot.findUnique({ where: { id: slotB.id }, select: { heldCount: true } }))?.heldCount === 1,
      "slot B's counters are untouched by the refusal",
    );
    expect((await prisma.appointment.count({ where: { patientId: p2.id } })) === 0, "no appointment was born from expired money");

    /* (c) Full slot: the capacity claim refuses before any row exists.   */
    await createPaymentOrder({ actor: p3, slotId: slotC.id, requestId: "day24-dod-fill" }); // maxPatients 1 → held 0→1
    await expectRejection("SLOT_FULL", "a second patient claiming the only seat", () =>
      createPaymentOrder({ actor: p4, slotId: slotC.id, requestId: "day24-dod-full" }),
    );
    expect(
      (await prisma.payment.count({ where: { patientId: p4.id } })) === 0 &&
        (await prisma.seatHold.count({ where: { patientId: p4.id } })) === 0,
      "the SLOT_FULL refusal created neither a payment nor a hold",
    );

    /* (d) A second checkout ABANDONS the first hold and hands the seat back. */
    const orderD = await createPaymentOrder({ actor: p4, slotId: slotD.id, requestId: "day24-dod-abd1" });
    const holdD = await prisma.seatHold.findFirst({ where: { patientId: p4.id, paymentOrderId: orderD.orderId } });
    expect(holdD !== null, "the first of p4's holds exists");
    if (!holdD) fail("unreachable: hold D not found");
    expect(
      (await prisma.slot.findUnique({ where: { id: slotD.id }, select: { heldCount: true } }))?.heldCount === 1,
      "slot D holds one seat before the replacement",
    );

    const orderE = await createPaymentOrder({ actor: p4, slotId: slotE.id, requestId: "day24-dod-abd2" });
    const holdDAfter = await prisma.seatHold.findUnique({ where: { id: holdD.id } });
    expect(holdDAfter?.releaseReason === $Enums.SeatHoldReleaseReason.ABANDONED, "the abandoned hold is released ABANDONED");
    expect(holdDAfter?.releasedAt !== null, "…with a release timestamp, never a deletion");
    expect(
      (await prisma.slot.findUnique({ where: { id: slotD.id }, select: { heldCount: true } }))?.heldCount === 0,
      "slot D's seat was handed back (held 1→0)",
    );
    const holdE = await prisma.seatHold.findFirst({ where: { patientId: p4.id, paymentOrderId: orderE.orderId } });
    expect(holdE !== null && holdE.releasedAt === null, "the replacement hold on slot E is live");
    expect(
      (await prisma.slot.findUnique({ where: { id: slotE.id }, select: { heldCount: true } }))?.heldCount === 1,
      "slot E holds the replacement seat",
    );
    console.log("refusals     : ALREADY_BOOKED (pre-money), HOLD_EXPIRED (payment stays PENDING), SLOT_FULL (no rows), ABANDONED release (seat handed back)");

    console.log("");
    console.log("Day 24 DoD passed — hold before money, one conversion, replay-safe, refusals leave nothing half-written.");
    console.log(`Note         : §17 step 4 re-fetch of ${gatewayPaymentId} skipped (decision B3) — signature computed locally.`);
    console.log("Manual DoD still standing: one real test-card payment through the browser (verify + webhook wiring).");
  } finally {
    await removeFixtures(state);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
