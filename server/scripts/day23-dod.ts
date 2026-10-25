// Day 23 DoD against the real local database AND the real Razorpay TEST API:
//
//   npx tsx scripts/day23-dod.ts
//
// Proves §17's first half (order + checkout seam) through the real
// paymentOrder.service — not just the pure layer, which `npm test` covers:
//
//   1. THE HAPPY PATH. A verified patient starts an order for a real seeded
//      slot: a `PENDING` Payment row lands with the `deriveConsultationFee`
//      amount, Razorpay answers with a real `order_…` id, the row's `orderId`
//      is linked to it, and exactly one `PAYMENT_ORDER_CREATED` audit row
//      records the money row.
//   2. NO SEAT IS CLAIMED. The slot's booked/held counters are byte-identical
//      before and after, and the patient owns no SeatHold and no Appointment —
//      Day 23 is order-only; Day 24's hold transaction is what reserves
//      capacity (decision 2).
//   3. THE WALLS. A DOCTOR actor is 403 FORBIDDEN (the service's own
//      double-enforcement, not just the route's); an unverified patient is 403
//      EMAIL_NOT_VERIFIED before any row exists; an unknown slot is 404
//      SLOT_NOT_FOUND.
//   4. THE DTO IS THE ROW. What the checkout would open with (orderId, amount,
//      currency, publishable keyId) is exactly what was stored — the client
//      cannot be shown a price the database disagrees with.
//
// SKIPS (banner + exit 0) when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are
// absent from server/.env: nothing here can run without a gateway, and the
// keys-free pure layer is still proven by `npm test`
// (tests/paymentOrder.test.ts). The keys themselves are the one manual
// ingredient of Day 23 — test-mode keys, pasted by hand, never committed.
//
// The orders this creates are uncaptured TEST orders: no money moves, and
// Razorpay expires them on its own — there is nothing to clean at the gateway.
//
// Clean-up: its own patient rows, their payment rows and their audit rows are
// removed in a `finally`, so the database ends as it started. Seeded slots are
// only READ, never written, so this script cannot disturb a generated schedule.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { deriveConsultationFee } from "../src/lib/fee.js";
import { createPaymentOrder } from "../src/services/paymentOrder.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error("===============================================================");
  console.error("SKIP: Day 23 DoD needs RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.");
  console.error("Paste test-mode keys into server/.env and re-run.");
  console.error("The keys-free pure layer still passed via `npm test`.");
  console.error("===============================================================");
  process.exit(0);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const FIXTURE_EMAIL_PREFIX = "day23-";

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
}

async function cleanup(state: RunState): Promise<void> {
  if (state.patientIds.length > 0) {
    // Order matters: Payment and AuditLog both reference users with Restrict.
    await prisma.payment.deleteMany({ where: { patientId: { in: state.patientIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: state.patientIds } } });
    await prisma.user.deleteMany({ where: { id: { in: state.patientIds } } });
  }
}

/** Removes fixtures a previous crashed run left behind (the day22 bargain). */
async function purgeStaleFixtures(): Promise<number> {
  const stale = await prisma.user.findMany({ where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } }, select: { id: true } });
  const patientIds = stale.map((row) => row.id);
  if (patientIds.length === 0) return 0;

  await prisma.payment.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: patientIds } } });
  return patientIds.length;
}

async function main(): Promise<void> {
  const clinic = await prisma.clinic.findFirst();
  if (!clinic) fail("No clinic row. Run the seed first (npm run db:seed).");

  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log(`purged      : ${purged} stale fixture patient(s) from a crashed run`);

  // One REAL seeded future slot of a VERIFIED doctor. Day 23 touches no seat,
  // so reusing a generated slot costs nothing — and proves the service against
  // exactly the rows a live patient would pick.
  const slot = await prisma.slot.findFirst({
    where: {
      startAt: { gt: new Date() },
      doctor: { role: "DOCTOR", doctorProfile: { verificationStatus: "VERIFIED", suspendedAt: null } },
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true,
      bookedCount: true,
      heldCount: true,
      doctor: {
        select: { id: true, fullName: true, doctorProfile: { select: { consultationFee: true } } },
      },
    },
  });
  if (!slot) fail("No future slot for a VERIFIED doctor. Run the seed first (npm run db:seed).");

  const expectedFee = deriveConsultationFee(slot.doctor.doctorProfile?.consultationFee ?? null, clinic.defaultConsultationFee);
  if (expectedFee <= 0) fail(`The seeded consultation fee is ${expectedFee} — the script needs a payable fee to prove the amount path.`);

  const state: RunState = { patientIds: [] };

  console.log(`clinic      : ${clinic.name} (${clinic.timezone}, default fee ${clinic.defaultConsultationFee}p)`);
  console.log(`slot        : ${slot.id} with ${slot.doctor.fullName} (expected fee ${expectedFee}p)`);

  try {
    const patient = await prisma.user.create({
      data: {
        role: "PATIENT",
        fullName: "Day23 DoD patient",
        email: `${FIXTURE_EMAIL_PREFIX}patient-${process.pid}@example.test`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true, fullName: true },
    });
    const patientActor: ActorContext = { id: patient.id, role: "PATIENT", name: patient.fullName };
    state.patientIds.push(patient.id);

    const countersBefore = { booked: slot.bookedCount, held: slot.heldCount };

    /* ---------------------------------------------------------------- */
    /* 1+2+4. Happy path: order, row, audit — and no seat claimed.       */
    /* ---------------------------------------------------------------- */
    const order = await createPaymentOrder({ actor: patientActor, slotId: slot.id, requestId: "day23-dod" });

    expect(order.orderId.startsWith("order_"), `gateway order id should start with "order_", got "${order.orderId}"`);
    expect(order.keyId === process.env.RAZORPAY_KEY_ID, "the DTO must carry the publishable keyId");
    expect(order.amountPaise === expectedFee, `order amount ${order.amountPaise}p !== derived fee ${expectedFee}p`);
    expect(order.currency === clinic.currency, `order currency ${order.currency} !== clinic currency ${clinic.currency}`);

    const row = await prisma.payment.findFirst({ where: { patientId: patient.id, orderId: order.orderId } });
    expect(row !== null, "the Payment row linked to this order exists");
    if (!row) fail("unreachable: the payment row was not found");
    expect(row.status === "PENDING", `payment should be PENDING, is ${row.status}`);
    expect(row.appointmentId === null, "no appointment is attached — Day 23 creates no booking");
    expect(row.amountPaise === order.amountPaise && row.currency === order.currency, "the row and the DTO agree on money");

    const audits = await prisma.auditLog.count({
      where: { action: "PAYMENT_ORDER_CREATED", targetType: "payment", targetId: row.id },
    });
    expect(audits === 1, `expected exactly one PAYMENT_ORDER_CREATED audit row, got ${audits}`);

    const countersAfter = await prisma.slot.findUnique({ where: { id: slot.id }, select: { bookedCount: true, heldCount: true } });
    expect(
      countersAfter?.bookedCount === countersBefore.booked && countersAfter?.heldCount === countersBefore.held,
      "Day 23 claims no capacity — the slot's counters must be untouched",
    );
    expect(
      (await prisma.seatHold.count({ where: { patientId: patient.id } })) === 0,
      "no SeatHold exists before Day 24",
    );
    expect(
      (await prisma.appointment.count({ where: { patientId: patient.id } })) === 0,
      "no Appointment exists before Day 24",
    );
    console.log("happy path : order created, row PENDING + linked, audit written, no seat claimed");

    /* ---------------------------------------------------------------- */
    /* 3. The walls.                                                     */
    /* ---------------------------------------------------------------- */
    const doctorActor: ActorContext = { id: slot.doctor.id, role: "DOCTOR", name: slot.doctor.fullName };
    await expectRejection("FORBIDDEN", "a DOCTOR starting an order", () =>
      createPaymentOrder({ actor: doctorActor, slotId: slot.id }),
    );

    const unverified = await prisma.user.create({
      data: {
        role: "PATIENT",
        fullName: "Day23 DoD unverified",
        email: `${FIXTURE_EMAIL_PREFIX}unverified-${process.pid}@example.test`,
      },
      select: { id: true, fullName: true },
    });
    state.patientIds.push(unverified.id);
    await expectRejection("EMAIL_NOT_VERIFIED", "an unverified patient starting an order", () =>
      createPaymentOrder({
        actor: { id: unverified.id, role: "PATIENT", name: unverified.fullName },
        slotId: slot.id,
      }),
    );
    expect(
      (await prisma.payment.count({ where: { patientId: unverified.id } })) === 0,
      "the email wall refuses before any payment row exists",
    );

    await expectRejection("SLOT_NOT_FOUND", "an unknown slot", () =>
      createPaymentOrder({ actor: patientActor, slotId: "00000000-0000-4000-8000-000000000000" }),
    );
    console.log("walls       : DOCTOR 403, unverified 403 (no row), unknown slot 404");

    console.log("");
    console.log("Day 23 DoD passed — order + row + audit, walls held, no seat claimed.");
    console.log("Manual DoD still standing: the checkout OPENING in a browser (client).");
  } finally {
    await cleanup(state);
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
