import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import {
  assertCapacityNotBelowCounters,
  assertNoSeatOrLiveHold,
  holdIsLive,
  slotHoldsSeatOrLiveHold,
  statusHoldsSeat,
} from "../src/lib/slotGuard.js";
import { AppError } from "../src/lib/appError.js";

/**
 * Day 16 — the pure §8.4 guard, pinned before any booking exists to guard
 * (decision 11). The database-backed behaviour (a REAL appointment refusing
 * a real edit) belongs to Day 36's harness; this file is where the judgment
 * itself is settled, so the 409/422 codes here are the contract the service
 * and the DoD script both rely on.
 */

const S = $Enums.AppointmentStatus;

const BEFORE_END = "2026-10-09T09:30:00.000Z";
const AT_END = "2026-10-09T10:00:00.000Z";
const AFTER_END = "2026-10-09T10:00:01.000Z";
const slotEndAt = new Date("2026-10-09T10:00:00.000Z");

function appointment(status: $Enums.AppointmentStatus, endAt: Date = slotEndAt) {
  return { status, slotEndAt: endAt };
}

function liveHold(expiresAt: string) {
  return { releasedAt: null, expiresAt: new Date(expiresAt) };
}

function releasedHold(expiresAt: string) {
  return { releasedAt: new Date("2026-10-01T00:00:00.000Z"), expiresAt: new Date(expiresAt) };
}

describe("statusHoldsSeat", () => {
  it("CONFIRMED and ARRIVED hold a seat unconditionally, even after the window ends", () => {
    // §8.1: both are bookedCount passengers from booking to slot end, and beyond
    // (a completed window is still evidence, not availability).
    assert.equal(statusHoldsSeat(S.CONFIRMED, slotEndAt, new Date(BEFORE_END)), true);
    assert.equal(statusHoldsSeat(S.CONFIRMED, slotEndAt, new Date(AT_END)), true);
    assert.equal(statusHoldsSeat(S.CONFIRMED, slotEndAt, new Date(AFTER_END)), true);
    assert.equal(statusHoldsSeat(S.ARRIVED, slotEndAt, new Date(AFTER_END)), true);
  });

  it("COMPLETED and NO_SHOW hold a seat only while the slot has not ended (§13.1)", () => {
    assert.equal(statusHoldsSeat(S.COMPLETED, slotEndAt, new Date(BEFORE_END)), true);
    assert.equal(statusHoldsSeat(S.NO_SHOW, slotEndAt, new Date(BEFORE_END)), true);
    // Half-open boundary: at the instant the window ends the seat is already gone.
    assert.equal(statusHoldsSeat(S.COMPLETED, slotEndAt, new Date(AT_END)), false);
    assert.equal(statusHoldsSeat(S.NO_SHOW, slotEndAt, new Date(AFTER_END)), false);
  });

  it("never holds for statuses that do not promise a seat", () => {
    // PENDING is declared for forward compatibility and never written (§13); if
    // a row with it ever surfaces it must NOT look like a held seat.
    assert.equal(statusHoldsSeat(S.PENDING, slotEndAt, new Date(BEFORE_END)), false);
    assert.equal(statusHoldsSeat(S.CANCELLED, slotEndAt, new Date(BEFORE_END)), false);
    assert.equal(statusHoldsSeat(S.REJECTED, slotEndAt, new Date(BEFORE_END)), false);
  });
});

describe("holdIsLive", () => {
  it("is live only while unreleased and unexpired (§8.6)", () => {
    // Expiry AFTER the check instant → live; at the instant (equal) → not live.
    assert.equal(holdIsLive(liveHold("2026-10-09T09:35:00.000Z"), new Date(BEFORE_END)), true);
    assert.equal(holdIsLive(liveHold(BEFORE_END), new Date(BEFORE_END)), false);
  });

  it("a released hold is never live, regardless of expiry", () => {
    assert.equal(holdIsLive(releasedHold("2026-10-09T09:05:00.000Z"), new Date(BEFORE_END)), false);
  });
});

describe("slotHoldsSeatOrLiveHold", () => {
  it("answers false for an empty slot", () => {
    assert.equal(slotHoldsSeatOrLiveHold([], [], new Date(BEFORE_END)), false);
  });

  it("a holding appointment alone makes the slot held", () => {
    assert.equal(slotHoldsSeatOrLiveHold([appointment(S.CONFIRMED)], [], new Date(BEFORE_END)), true);
    // A COMPLETED window after it ended is not a hold — the slot is free for edits.
    assert.equal(slotHoldsSeatOrLiveHold([appointment(S.COMPLETED)], [], new Date(AFTER_END)), false);
  });

  it("a live hold alone makes the slot held", () => {
    assert.equal(slotHoldsSeatOrLiveHold([], [liveHold("2026-10-09T09:35:00.000Z")], new Date(BEFORE_END)), true);
  });

  it("an expired or released hold does not — a slot is held only by live promises", () => {
    assert.equal(slotHoldsSeatOrLiveHold([], [liveHold(BEFORE_END)], new Date(BEFORE_END)), false);
    assert.equal(slotHoldsSeatOrLiveHold([], [releasedHold("2026-10-09T09:35:00.000Z")], new Date(BEFORE_END)), false);
  });

  it("mixes: any one live promise among many inert ones wins", () => {
    const inputs = {
      appointments: [appointment(S.CANCELLED), appointment(S.PENDING)],
      holds: [releasedHold("2026-10-09T09:35:00.000Z")],
    };
    assert.equal(slotHoldsSeatOrLiveHold(inputs.appointments, inputs.holds, new Date(BEFORE_END)), false);
    assert.equal(
      slotHoldsSeatOrLiveHold(
        inputs.appointments,
        [...inputs.holds, liveHold("2026-10-09T09:35:00.000Z")],
        new Date(BEFORE_END),
      ),
      true,
    );
  });
});

describe("assertNoSeatOrLiveHold", () => {
  it("throws 409 SLOT_HELD for a held slot", () => {
    assert.throws(
      () => assertNoSeatOrLiveHold([appointment(S.CONFIRMED)], [], new Date(BEFORE_END)),
      (err: unknown) =>
        err instanceof AppError && err.status === 409 && err.code === "SLOT_HELD",
    );
  });

  it("passes silently for a free slot — the same test usable by time-edit and disable", () => {
    assert.doesNotThrow(() => assertNoSeatOrLiveHold([], [], new Date(BEFORE_END)));
    assert.doesNotThrow(() =>
      assertNoSeatOrLiveHold([appointment(S.COMPLETED)], [releasedHold("2026-10-09T09:00:00.000Z")], new Date(AFTER_END)),
    );
  });
});

describe("assertCapacityNotBelowCounters", () => {
  it("refuses to lower maxPatients below booked + held (§8.4)", () => {
    // 2 booked + 1 held → floor of 3. newMax 3 is fine; 2 is refused.
    assert.doesNotThrow(() => assertCapacityNotBelowCounters(3, 2, 1));
    assert.throws(
      () => assertCapacityNotBelowCounters(2, 2, 1),
      (err: unknown) => err instanceof AppError && err.status === 409 && err.code === "CAPACITY_BELOW_BOOKED",
    );
  });

  it("the message carries the exact §8.4 counts", () => {
    assert.throws(
      () => assertCapacityNotBelowCounters(0, 4, 0),
      (err: unknown) =>
        err instanceof AppError && /4 patients booked and 0 awaiting payment/.test(err.message),
    );
  });

  it("uses the stored counters, not the live rows — that asymmetry is deliberate", () => {
    // A slot with zero live rows but a stale counter is still refused: the
    // counter is what the booking transaction incremented (§8.1).
    assert.throws(() => assertCapacityNotBelowCounters(0, 1, 0));
  });
});