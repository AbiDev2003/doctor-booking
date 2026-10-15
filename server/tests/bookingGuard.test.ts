import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import {
  ACTIVE_BOOKING_STATUSES,
  assertNoDuplicateForSlot,
  assertPatientSeatCap,
  assertSlotBookableForBooking,
} from "../src/lib/bookingGuard.js";
import type { BookabilityContext, BookabilitySlot } from "../src/lib/availability.js";

/**
 * Day 19 — the pure booking judgment, pinned before the DB-backed race (the
 * DoD script, `scripts/day19-dod.ts`). The codes here are the contract the
 * service and the client both rely on; the atomic last-seat guard itself is
 * SQL, so it is proven by the DoD race, not here.
 */

/** Runs `fn`, expecting it to throw an AppError carrying `code`. */
function expectCode(code: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code} but no error was thrown`);
}

const NOW = new Date("2026-10-09T08:00:00.000Z");

function slot(overrides: Partial<BookabilitySlot> = {}): BookabilitySlot {
  return {
    slotDate: "2026-10-10",
    startAt: new Date("2026-10-10T04:00:00.000Z"),
    endAt: new Date("2026-10-10T05:00:00.000Z"),
    isDisabled: false,
    maxPatients: 5,
    bookedCount: 0,
    heldCount: 0,
    ...overrides,
  };
}

function context(overrides: Partial<BookabilityContext> = {}): BookabilityContext {
  return {
    now: NOW,
    minLeadMinutes: 0,
    horizon: { earliestDate: "2026-10-09", latestDate: "2026-12-08" },
    unavailabilities: [],
    ...overrides,
  };
}

describe("ACTIVE_BOOKING_STATUSES", () => {
  it("is exactly the two statuses the §15 partial unique index names", () => {
    // COMPLETED/NO_SHOW are deliberately absent: they hold a seat (slotGuard's
    // SEAT_HOLDING_STATUSES) but do not block a fresh booking by that patient.
    assert.deepEqual([...ACTIVE_BOOKING_STATUSES], [
      $Enums.AppointmentStatus.CONFIRMED,
      $Enums.AppointmentStatus.ARRIVED,
    ]);
  });
});

describe("assertPatientSeatCap", () => {
  it("allows a booking below the cap", () => {
    assert.doesNotThrow(() => assertPatientSeatCap(2, 3));
    assert.doesNotThrow(() => assertPatientSeatCap(0, 3));
  });

  it("refuses at or above the cap (bookings + live holds)", () => {
    expectCode("BOOKING_CAP_REACHED", () => assertPatientSeatCap(3, 3));
    expectCode("BOOKING_CAP_REACHED", () => assertPatientSeatCap(4, 3));
  });
});

describe("assertNoDuplicateForSlot", () => {
  it("passes when the patient has no active booking for the slot", () => {
    assert.doesNotThrow(() => assertNoDuplicateForSlot(false));
  });

  it("refuses a second active booking for the same slot", () => {
    expectCode("ALREADY_BOOKED", () => assertNoDuplicateForSlot(true));
  });
});

describe("assertSlotBookableForBooking", () => {
  it("passes a plain, future, in-horizon, uninterrupted slot", () => {
    assert.doesNotThrow(() => assertSlotBookableForBooking(slot(), context()));
  });

  it("does NOT judge fullness — the guarded update owns capacity", () => {
    // Counters full here; the atomic UPDATE, not this guard, decides SLOT_FULL.
    assert.doesNotThrow(() =>
      assertSlotBookableForBooking(slot({ maxPatients: 2, bookedCount: 2 }), context()),
    );
  });

  it("refuses a disabled slot", () => {
    expectCode("SLOT_DISABLED", () => assertSlotBookableForBooking(slot({ isDisabled: true }), context()));
  });

  it("refuses a slot that has already started (including the lead-time window)", () => {
    const started = slot({
      startAt: new Date("2026-10-10T04:00:00.000Z"),
      endAt: new Date("2026-10-10T05:00:00.000Z"),
    });
    expectCode("SLOT_STARTED", () =>
      assertSlotBookableForBooking(started, context({ now: new Date("2026-10-10T04:00:00.000Z") })),
    );
    // A 30-minute lead time closes the slot earlier than its start.
    expectCode("SLOT_STARTED", () =>
      assertSlotBookableForBooking(started, context({ now: new Date("2026-10-10T03:45:00.000Z"), minLeadMinutes: 30 })),
    );
  });

  it("refuses a date outside the booking horizon", () => {
    expectCode("BOOKING_OUTSIDE_HORIZON", () =>
      assertSlotBookableForBooking(slot({ slotDate: "2026-12-09" }), context()),
    );
  });

  it("refuses a slot overlapping a doctor-unavailability window", () => {
    expectCode("DOCTOR_UNAVAILABLE", () =>
      assertSlotBookableForBooking(
        slot(),
        context({
          unavailabilities: [
            { startAt: new Date("2026-10-10T04:30:00.000Z"), endAt: new Date("2026-10-10T06:00:00.000Z") },
          ],
        }),
      ),
    );
  });
});
