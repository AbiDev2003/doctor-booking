import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasStarted,
  instantsOverlap,
  isFull,
  isSlotBookable,
  isWithinHorizon,
  overlapsUnavailability,
  remainingSeats,
} from "../src/lib/availability.js";
import type { BookabilityContext, BookabilitySlot, InstantWindow } from "../src/lib/availability.js";

/**
 * Day 17 — the pure bookability predicate, pinned before the endpoint exists to
 * serve it. This settles the contract (what the storefront hides) so the
 * service is a thin mapper over a rule that is already proven. The
 * database-backed behaviour — a REAL disabled/full/unavailable slot vanishing
 * from the response — belongs to `scripts/day17-dod.ts`, the same split Day 16
 * used between `slotGuard.test.ts` and `day16-dod.ts`.
 */

const NOW = "2026-10-12T08:00:00.000Z";

function slot(overrides: Partial<BookabilitySlot> = {}): BookabilitySlot {
  return {
    slotDate: "2026-10-12",
    startAt: new Date("2026-10-12T09:00:00.000Z"),
    endAt: new Date("2026-10-12T09:30:00.000Z"),
    isDisabled: false,
    maxPatients: 4,
    bookedCount: 0,
    heldCount: 0,
    ...overrides,
  };
}

function context(overrides: Partial<BookabilityContext> = {}): BookabilityContext {
  return {
    now: new Date(NOW),
    minLeadMinutes: 0,
    horizon: { earliestDate: "2026-10-10", latestDate: "2026-10-24" },
    unavailabilities: [],
    ...overrides,
  };
}

function window(startAt: string, endAt: string): InstantWindow {
  return { startAt: new Date(startAt), endAt: new Date(endAt) };
}

describe("instantsOverlap", () => {
  it("is true for partial, contained and identical overlaps", () => {
    const a = window("2026-10-12T09:00:00.000Z", "2026-10-12T10:00:00.000Z");
    assert.equal(instantsOverlap(a, window("2026-10-12T09:30:00.000Z", "2026-10-12T10:30:00.000Z")), true);
    assert.equal(instantsOverlap(a, window("2026-10-12T09:15:00.000Z", "2026-10-12T09:45:00.000Z")), true);
    assert.equal(instantsOverlap(a, window("2026-10-12T09:00:00.000Z", "2026-10-12T10:00:00.000Z")), true);
  });

  it("is false when the windows only touch — half-open edges do not overlap", () => {
    const a = window("2026-10-12T09:00:00.000Z", "2026-10-12T10:00:00.000Z");
    assert.equal(instantsOverlap(a, window("2026-10-12T10:00:00.000Z", "2026-10-12T11:00:00.000Z")), false);
    assert.equal(instantsOverlap(a, window("2026-10-12T08:00:00.000Z", "2026-10-12T09:00:00.000Z")), false);
  });

  it("is false for disjoint windows", () => {
    const a = window("2026-10-12T09:00:00.000Z", "2026-10-12T10:00:00.000Z");
    assert.equal(instantsOverlap(a, window("2026-10-12T11:00:00.000Z", "2026-10-12T12:00:00.000Z")), false);
  });
});

describe("isWithinHorizon", () => {
  const horizon = { earliestDate: "2026-10-10", latestDate: "2026-10-24" };

  it("accepts dates inside the range, inclusive at both ends", () => {
    assert.equal(isWithinHorizon("2026-10-17", horizon), true);
    assert.equal(isWithinHorizon("2026-10-10", horizon), true);
    assert.equal(isWithinHorizon("2026-10-24", horizon), true);
  });

  it("rejects dates outside the range", () => {
    assert.equal(isWithinHorizon("2026-10-09", horizon), false);
    assert.equal(isWithinHorizon("2026-10-25", horizon), false);
  });
});

describe("hasStarted", () => {
  const target = window("2026-10-12T09:00:00.000Z", "2026-10-12T09:30:00.000Z");

  it("is false for a future slot", () => {
    assert.equal(hasStarted(target, new Date("2026-10-12T08:59:00.000Z"), 0), false);
  });

  it("is true at the instant the slot opens — closed, not bookable until the last second", () => {
    assert.equal(hasStarted(target, new Date("2026-10-12T09:00:00.000Z"), 0), true);
  });

  it("respects the lead-time window: starts are closed once now + lead reaches them", () => {
    // 10 minutes of lead: a 09:00 slot is closed from 08:50 onward.
    assert.equal(hasStarted(target, new Date("2026-10-12T08:49:59.000Z"), 10), false);
    assert.equal(hasStarted(target, new Date("2026-10-12T08:50:00.000Z"), 10), true);
  });
});

describe("isFull", () => {
  it("is false while a seat remains", () => {
    assert.equal(isFull({ maxPatients: 4, bookedCount: 2, heldCount: 1 }), false);
  });

  it("is true when booked + held reaches capacity, and stays true when over", () => {
    assert.equal(isFull({ maxPatients: 4, bookedCount: 4, heldCount: 0 }), true);
    assert.equal(isFull({ maxPatients: 4, bookedCount: 3, heldCount: 1 }), true);
    assert.equal(isFull({ maxPatients: 4, bookedCount: 5, heldCount: 0 }), true);
  });
});

describe("overlapsUnavailability", () => {
  const target = slot();

  it("is false with no disruptions", () => {
    assert.equal(overlapsUnavailability(target, []), false);
  });

  it("is true when a disruption overlaps the slot's window", () => {
    assert.equal(
      overlapsUnavailability(target, [window("2026-10-12T09:15:00.000Z", "2026-10-12T09:45:00.000Z")]),
      true,
    );
  });

  it("is false when a disruption merely touches the slot's edge", () => {
    assert.equal(
      overlapsUnavailability(target, [window("2026-10-12T09:30:00.000Z", "2026-10-12T10:00:00.000Z")]),
      false,
    );
  });
});

describe("remainingSeats", () => {
  it("counts free seats", () => {
    assert.equal(remainingSeats({ maxPatients: 4, bookedCount: 1, heldCount: 1 }), 2);
  });

  it("floors at zero when the counters reach or exceed capacity", () => {
    assert.equal(remainingSeats({ maxPatients: 4, bookedCount: 4, heldCount: 0 }), 0);
    assert.equal(remainingSeats({ maxPatients: 4, bookedCount: 5, heldCount: 1 }), 0);
  });
});

describe("isSlotBookable", () => {
  it("is true for a clean slot inside the horizon", () => {
    assert.equal(isSlotBookable(slot(), context()), true);
  });

  it("hides a disabled slot (§8.4)", () => {
    assert.equal(isSlotBookable(slot({ isDisabled: true }), context()), false);
  });

  it("hides a full slot (§8.1)", () => {
    assert.equal(isSlotBookable(slot({ bookedCount: 4 }), context()), false);
    // A live hold is a claimed seat too.
    assert.equal(isSlotBookable(slot({ bookedCount: 3, heldCount: 1 }), context()), false);
  });

  it("hides a slot that has started or is inside the lead window (§8.5)", () => {
    assert.equal(isSlotBookable(slot({ startAt: new Date("2026-10-12T08:00:00.000Z") }), context()), false);
    assert.equal(isSlotBookable(slot(), context({ minLeadMinutes: 90 })), false);
  });

  it("hides a slot outside the booking horizon (§10)", () => {
    assert.equal(isSlotBookable(slot({ slotDate: "2026-10-25" }), context()), false);
    assert.equal(isSlotBookable(slot({ slotDate: "2026-10-09" }), context()), false);
  });

  it("hides a slot overlapping a disruption (§11)", () => {
    const overlaps = context({
      unavailabilities: [window("2026-10-12T09:10:00.000Z", "2026-10-12T09:20:00.000Z")],
    });
    assert.equal(isSlotBookable(slot(), overlaps), false);
  });

  it("a slot that is merely adjacent to a disruption stays bookable", () => {
    const adjacent = context({
      unavailabilities: [window("2026-10-12T09:30:00.000Z", "2026-10-12T10:00:00.000Z")],
    });
    assert.equal(isSlotBookable(slot(), adjacent), true);
  });
});
