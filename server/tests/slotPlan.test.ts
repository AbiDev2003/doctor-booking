import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  enumerateDates,
  planSlotsForDoctor,
  weekdayOfDate,
  windowsOverlap,
} from "../src/lib/slotPlan.js";

describe("weekdayOfDate", () => {
  it("is calendar arithmetic over the date's parts, with no zone involved", () => {
    // 2026-09-30 is a Wednesday in every zone; that is the point — a calendar
    // date's weekday never depends on an instant.
    assert.equal(weekdayOfDate("2026-09-30"), "WED");
    assert.equal(weekdayOfDate("2026-10-05"), "MON");
    assert.equal(weekdayOfDate("2026-10-11"), "SUN");
  });

  it("rejects a malformed or impossible date instead of rolling it over", () => {
    // Date.UTC would silently turn 2026-02-30 into 2026-03-02; the round-trip
    // check must reject it. A weekday for a date that does not exist is not
    // worth answering confidently.
    assert.equal(weekdayOfDate("2026-02-30"), null);
    assert.equal(weekdayOfDate("2026-13-01"), null);
    assert.equal(weekdayOfDate("2026-00-10"), null);
    assert.equal(weekdayOfDate("not-a-date"), null);
    assert.equal(weekdayOfDate("2026-09-30T00:00:00Z"), null);
  });

  it("accepts valid leap-day dates", () => {
    assert.equal(weekdayOfDate("2024-02-29"), "THU");
    assert.equal(weekdayOfDate("2026-02-28"), "SAT"); // 2026 is not a leap year
  });
});

describe("enumerateDates", () => {
  it("is inclusive of both ends: a 60-day horizon yields 61 dates", () => {
    const dates = enumerateDates("2026-10-09", 60);
    assert.equal(dates.length, 61);
    assert.equal(dates[0], "2026-10-09");
    assert.equal(dates[60], "2026-12-08");
  });

  it("walks calendar arithmetic across month and year boundaries", () => {
    const dates = enumerateDates("2026-12-30", 3);
    assert.deepEqual(dates, ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("yields a single date for a zero horizon", () => {
    assert.deepEqual(enumerateDates("2026-10-09", 0), ["2026-10-09"]);
  });

  it("yields no dates for a negative horizon or malformed first date", () => {
    assert.deepEqual(enumerateDates("2026-10-09", -1), []);
    assert.deepEqual(enumerateDates("2026-02-30", 60), []);
    assert.deepEqual(enumerateDates("nope", 60), []);
  });
});

const WINDOW = (startTime: string, endTime: string, weekday: "MON" | "TUE" = "MON", maxPatients = 12) => ({
  weekday,
  startTime,
  endTime,
  maxPatients,
});

const plan = (input: Partial<Parameters<typeof planSlotsForDoctor>[0]> = {}) =>
  planSlotsForDoctor({
    windows: [WINDOW("09:00", "12:00")],
    firstDate: "2026-10-05", // a Monday
    horizonDays: 7,
    existingDates: new Set<string>(),
    ...input,
  });

describe("planSlotsForDoctor", () => {
  it("materialises a slot for every matching weekday inside the horizon", () => {
    const { slots, skippedExistingDates } = plan();
    // 8 dates, Mon Oct 5 .. Mon Oct 12: each Monday appears twice.
    assert.equal(slots.length, 2);
    assert.equal(skippedExistingDates, 0);
    assert.deepEqual(slots, [
      { date: "2026-10-05", startTime: "09:00", endTime: "12:00", maxPatients: 12 },
      { date: "2026-10-12", startTime: "09:00", endTime: "12:00", maxPatients: 12 },
    ]);
  });

  it("skips an already-stocked date whole (decision 1), not window-by-window", () => {
    const { slots, skippedExistingDates } = plan({ existingDates: new Set(["2026-10-05"]) });
    assert.equal(slots.length, 1);
    assert.deepEqual(slots.map((s) => s.date), ["2026-10-12"]);
    assert.equal(skippedExistingDates, 1);
  });

  it("is deterministic: same inputs, same row order", () => {
    const windows = [WINDOW("09:00", "12:00"), WINDOW("14:00", "16:00"), WINDOW("09:00", "11:00", "TUE")];
    const a = planSlotsForDoctor({ windows, firstDate: "2026-10-05", horizonDays: 7, existingDates: new Set() });
    const b = planSlotsForDoctor({ windows, firstDate: "2026-10-05", horizonDays: 7, existingDates: new Set() });
    assert.deepEqual(a.slots, b.slots);
    // The horizon is inclusive, so it spans Oct 5..Oct 12 — two Mondays. Both
    // MON windows on each, in template order, plus the single TUE window.
    assert.deepEqual(
      a.slots.map((s) => `${s.date} ${s.startTime}-${s.endTime}`),
      [
        "2026-10-05 09:00-12:00",
        "2026-10-05 14:00-16:00",
        "2026-10-06 09:00-11:00",
        "2026-10-12 09:00-12:00",
        "2026-10-12 14:00-16:00",
      ],
    );
  });

  it("carries maxPatients per window onto every generated slot", () => {
    const windows = [WINDOW("09:00", "12:00", "MON", 4)];
    const { slots } = planSlotsForDoctor({ windows, firstDate: "2026-10-05", horizonDays: 7, existingDates: new Set() });
    assert.ok(slots.every((s) => s.maxPatients === 4));
  });

  it("stays a non-writer: a fully stocked horizon plans nothing", () => {
    const { slots, skippedExistingDates } = plan({
      firstDate: "2026-10-05",
      horizonDays: 7, // inclusive horizon: Oct 5..Oct 12 — both Mondays covered
      existingDates: new Set(["2026-10-05", "2026-10-12"]),
    });
    assert.equal(slots.length, 0);
    assert.equal(skippedExistingDates, 2);
  });
});

describe("windowsOverlap", () => {
  it("treats windows as half-open [start, end): adjacent windows do NOT overlap", () => {
    assert.equal(windowsOverlap({ startTime: "09:00", endTime: "12:00" }, { startTime: "12:00", endTime: "15:00" }), false);
  });

  it("flags identical, partial-overlap and containment as collisions", () => {
    assert.equal(windowsOverlap({ startTime: "09:00", endTime: "12:00" }, { startTime: "09:00", endTime: "12:00" }), true);
    assert.equal(windowsOverlap({ startTime: "09:00", endTime: "12:00" }, { startTime: "10:00", endTime: "11:00" }), true);
    assert.equal(windowsOverlap({ startTime: "09:00", endTime: "12:00" }, { startTime: "11:00", endTime: "15:00" }), true);
  });
});