import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import {
  RESCHEDULE_ROLES,
  RESCHEDULABLE_STATUS,
  assertNotSameSlot,
  assertRescheduleActor,
  assertRescheduleOwnership,
  assertRescheduleReason,
  assertRescheduleScope,
  assertReschedulableStatus,
  classifyRescheduleDelta,
} from "../src/lib/rescheduleGuard.js";

/**
 * Day 22 — the §14/§8.5 reschedule judgment, pinned before the DB-backed proofs
 * (`scripts/day22-dod.ts`). The codes here are the contract the service and the
 * client both rely on; the atomic seat transfer behind it is SQL, proven by the
 * DoD script, not here. The §8.5 patient cutoff is `assertPatientCancelAllowed`
 * (transitionGuard.ts) and is covered by `transitionGuard.test.ts`.
 */

/** Runs `fn`, expecting it to throw an AppError carrying `code`. */
function expectCode(code: string, fn: () => void): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code} but no error was thrown`);
}

const { AppointmentStatus: Status, UserRole: Role } = $Enums;

describe("§14 who may reschedule", () => {
  it("admits exactly PATIENT, ADMIN and STAFF", () => {
    assert.deepEqual(
      new Set(RESCHEDULE_ROLES),
      new Set([Role.PATIENT, Role.ADMIN, Role.STAFF]),
    );
    for (const role of RESCHEDULE_ROLES) {
      assert.doesNotThrow(() => assertRescheduleActor(role));
    }
  });

  it("refuses a DOCTOR with 403 FORBIDDEN", () => {
    expectCode("FORBIDDEN", () => assertRescheduleActor(Role.DOCTOR));
  });

  it("lets staff move anyone but a patient only their own booking", () => {
    assert.doesNotThrow(() => assertRescheduleOwnership({ id: "p1", role: Role.PATIENT }, "p1"));
    expectCode("FORBIDDEN", () => assertRescheduleOwnership({ id: "p2", role: Role.PATIENT }, "p1"));
    assert.doesNotThrow(() => assertRescheduleOwnership({ id: "s1", role: Role.STAFF }, "p1"));
    assert.doesNotThrow(() => assertRescheduleOwnership({ id: "a1", role: Role.ADMIN }, "p1"));
  });

  it("keeps a patient within the same doctor; staff may cross", () => {
    assert.doesNotThrow(() => assertRescheduleScope(Role.PATIENT, "doc-1", "doc-1"));
    expectCode("CROSS_DOCTOR_RESCHEDULE", () => assertRescheduleScope(Role.PATIENT, "doc-1", "doc-2"));
    assert.doesNotThrow(() => assertRescheduleScope(Role.STAFF, "doc-1", "doc-2"));
    assert.doesNotThrow(() => assertRescheduleScope(Role.ADMIN, "doc-1", "doc-2"));
  });

  it("requires a reason from staff only", () => {
    expectCode("REASON_REQUIRED", () => assertRescheduleReason("   ", Role.STAFF));
    expectCode("REASON_REQUIRED", () => assertRescheduleReason(undefined, Role.ADMIN));
    assert.doesNotThrow(() => assertRescheduleReason("Doctor running late", Role.STAFF));
    assert.doesNotThrow(() => assertRescheduleReason(undefined, Role.PATIENT));
  });
});

describe("§14 what may be rescheduled", () => {
  it("admits CONFIRMED only", () => {
    assert.equal(RESCHEDULABLE_STATUS, Status.CONFIRMED);
    assert.doesNotThrow(() => assertReschedulableStatus(Status.CONFIRMED));
    for (const status of [
      Status.ARRIVED,
      Status.COMPLETED,
      Status.NO_SHOW,
      Status.CANCELLED,
      Status.REJECTED,
    ]) {
      expectCode("INVALID_TRANSITION", () => assertReschedulableStatus(status));
    }
  });

  it("refuses the slot the appointment is already in, with 422 SAME_SLOT", () => {
    assert.doesNotThrow(() => assertNotSameSlot("slot-1", "slot-2"));
    expectCode("SAME_SLOT", () => assertNotSameSlot("slot-1", "slot-1"));
  });
});

describe("§14 fee-delta classification", () => {
  it("does nothing when the fee is unchanged", () => {
    for (const hasPaidPayment of [false, true]) {
      const plan = classifyRescheduleDelta(50000, 50000, hasPaidPayment);
      assert.equal(plan.deltaPaise, 0);
      assert.equal(plan.action, "NONE");
      assert.equal(plan.refundAmountPaise, 0);
    }
  });

  it("adjusts the snapshot when no money stands (unpaid / pay-at-clinic)", () => {
    const higher = classifyRescheduleDelta(50000, 80000, false);
    assert.equal(higher.action, "ADJUST_SNAPSHOTS");
    assert.equal(higher.deltaPaise, 30000);
    assert.equal(higher.refundAmountPaise, 0);

    const cheaper = classifyRescheduleDelta(80000, 50000, false);
    assert.equal(cheaper.action, "ADJUST_SNAPSHOTS");
    assert.equal(cheaper.deltaPaise, -30000);
    assert.equal(cheaper.refundAmountPaise, 0);
  });

  it("refuses a dearer move against a PAID payment (409 PAYMENT_REQUIRED)", () => {
    expectCode("PAYMENT_REQUIRED", () => classifyRescheduleDelta(50000, 80000, true));
  });

  it("queues a RESCHEDULE_DELTA refund of the difference for a cheaper paid move", () => {
    const plan = classifyRescheduleDelta(80000, 50000, true);
    assert.equal(plan.action, "QUEUE_REFUND");
    assert.equal(plan.deltaPaise, -30000);
    assert.equal(plan.refundAmountPaise, 30000);
  });
});
