import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import {
  TERMINAL_STATUSES,
  TRANSITION_MATRIX,
  allowedTargets,
  assertArrivalAllowed,
  assertNoPendingPayment,
  assertNoShowAllowed,
  assertPatientCancelAllowed,
  assertReasonPresent,
  assertTransition,
  historyEventFor,
  isTerminal,
} from "../src/lib/transitionGuard.js";

/**
 * Day 21 — the §13/§13.1 transition judgment, pinned before the DB-backed proofs
 * (`scripts/day21-dod.ts`). The codes here are the contract the service and the
 * client both rely on; the atomic conditional `UPDATE` behind it is SQL, proven
 * by the DoD script, not here.
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

describe("§13 transition matrix", () => {
  it("has no duplicate from → to pair", () => {
    const seen = new Set<string>();
    for (const row of TRANSITION_MATRIX) {
      const key = `${row.from}->${row.to}`;
      assert.equal(seen.has(key), false, `duplicate matrix row ${key}`);
      seen.add(key);
    }
  });

  it("names exactly the four terminal states", () => {
    assert.deepEqual(new Set(TERMINAL_STATUSES), new Set([Status.COMPLETED, Status.NO_SHOW, Status.CANCELLED, Status.REJECTED]));
    for (const terminal of TERMINAL_STATUSES) {
      assert.equal(isTerminal(terminal), true);
      assert.deepEqual(allowedTargets(terminal), [], `${terminal} must allow nothing`);
    }
  });

  it("admits COMPLETED only from ARRIVED, never from CONFIRMED", () => {
    assert.deepEqual(allowedTargets(Status.ARRIVED), [Status.CANCELLED, Status.COMPLETED]);
    assert.equal(allowedTargets(Status.CONFIRMED).includes(Status.COMPLETED), false);
  });

  it("allows every listed role to take its row", () => {
    for (const row of TRANSITION_MATRIX) {
      for (const role of row.roles) {
        assert.doesNotThrow(
          () => assertTransition(row.from, row.to, role),
          `${role} must be allowed ${row.from} -> ${row.to}`,
        );
      }
    }
  });

  it("refuses a pair not in the matrix with 409 INVALID_TRANSITION naming the status", () => {
    const err = expectCode("INVALID_TRANSITION", () => assertTransition(Status.CONFIRMED, Status.COMPLETED, Role.STAFF));
    assert.match(err.message, /CONFIRMED/);
    assert.match(err.message, /ARRIVED/);
  });

  it("refuses every transition out of a terminal state", () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const to of [Status.ARRIVED, Status.COMPLETED, Status.CANCELLED, Status.NO_SHOW, Status.REJECTED]) {
        expectCode("INVALID_TRANSITION", () => assertTransition(terminal, to, Role.ADMIN));
      }
    }
  });

  it("refuses a legal pair for a role it does not admit with 403 FORBIDDEN", () => {
    // A PATIENT cannot check anyone in (§13.1); a DOCTOR cannot change attendance at all.
    expectCode("FORBIDDEN", () => assertTransition(Status.CONFIRMED, Status.ARRIVED, Role.PATIENT));
    expectCode("FORBIDDEN", () => assertTransition(Status.ARRIVED, Status.COMPLETED, Role.DOCTOR));
    expectCode("FORBIDDEN", () => assertTransition(Status.CONFIRMED, Status.REJECTED, Role.PATIENT));
  });
});

describe("§13.1 clock walls", () => {
  const start = new Date("2026-10-15T10:00:00.000Z");
  const end = new Date("2026-10-15T10:30:00.000Z");

  it("allows ARRIVED exactly from the slot's start", () => {
    expectCode("SLOT_NOT_STARTED", () => assertArrivalAllowed(start, new Date("2026-10-15T09:59:59.999Z")));
    assert.doesNotThrow(() => assertArrivalAllowed(start, new Date("2026-10-15T10:00:00.000Z")));
  });

  it("allows NO_SHOW only once the slot has ended", () => {
    expectCode("SLOT_NOT_ENDED", () => assertNoShowAllowed(end, new Date("2026-10-15T10:29:59.999Z")));
    assert.doesNotThrow(() => assertNoShowAllowed(end, new Date("2026-10-15T10:30:00.000Z")));
  });

  it("bounds the patient cancel by the cutoff and the slot start", () => {
    // 60-minute cutoff on a 10:00 start → the wall is 09:00.
    assert.doesNotThrow(() => assertPatientCancelAllowed(start, new Date("2026-10-15T08:59:59.999Z"), 60, false));
    expectCode("CUTOFF_REACHED", () => assertPatientCancelAllowed(start, new Date("2026-10-15T09:00:00.000Z"), 60, false));
    expectCode("CUTOFF_REACHED", () => assertPatientCancelAllowed(start, new Date("2026-10-15T09:30:00.000Z"), 60, false));
    expectCode("CUTOFF_REACHED", () => assertPatientCancelAllowed(start, new Date("2026-10-15T10:00:00.000Z"), 60, false));
  });

  it("waives the cutoff for a clinic-caused appointment until the slot starts", () => {
    assert.doesNotThrow(() => assertPatientCancelAllowed(start, new Date("2026-10-15T09:30:00.000Z"), 60, true));
    expectCode("CUTOFF_REACHED", () => assertPatientCancelAllowed(start, new Date("2026-10-15T10:00:00.000Z"), 60, true));
  });
});

describe("§13.1 closing wall and §8.4/§20 reason rule", () => {
  it("refuses to close a visit with a pending payment", () => {
    expectCode("PAYMENT_PENDING", () => assertNoPendingPayment(true));
    assert.doesNotThrow(() => assertNoPendingPayment(false));
  });

  it("requires a non-blank reason", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expectCode("REASON_REQUIRED", () => assertReasonPresent(bad, "reject a booking"));
    }
    assert.doesNotThrow(() => assertReasonPresent("policy refusal", "reject a booking"));
  });
});

describe("§13 history event mapping", () => {
  it("maps every non-create transition to its event", () => {
    assert.equal(historyEventFor(Status.ARRIVED), $Enums.AppointmentEventType.ARRIVED);
    assert.equal(historyEventFor(Status.COMPLETED), $Enums.AppointmentEventType.COMPLETED);
    assert.equal(historyEventFor(Status.NO_SHOW), $Enums.AppointmentEventType.NO_SHOW);
    assert.equal(historyEventFor(Status.CANCELLED), $Enums.AppointmentEventType.CANCELLED);
    assert.equal(historyEventFor(Status.REJECTED), $Enums.AppointmentEventType.REJECTED);
  });

  it("has no event for CONFIRMED or PENDING (a 500, never a silent write)", () => {
    expectCode("NO_HISTORY_EVENT", () => historyEventFor(Status.CONFIRMED));
    expectCode("NO_HISTORY_EVENT", () => historyEventFor(Status.PENDING));
  });
});
