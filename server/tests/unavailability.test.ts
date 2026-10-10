import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import {
  CASCADABLE_STATUS,
  assertValidDisruptionWindow,
  isClinicCaused,
  selectOnlyConfirmed,
} from "../src/lib/unavailability.js";
import { AppError } from "../src/lib/appError.js";

/**
 * Day 18 — the pure §12 cascade judgments, pinned before the endpoint exists
 * to serve them. This settles the contract (who is affected, what "clinic
 * caused" means, that a window must have positive length) so the service in
 * `appointmentCascade.service.ts` is a thin I/O shell over rules that are
 * already proven. The database-backed behaviour — a REAL overlapping CONFIRMED
 * booking being marked, notified and auto-cancelled while a COMPLETED one is
 * untouched — belongs to `scripts/day18-dod.ts`, the same split every day
 * since 16 has used.
 */

const S = $Enums.AppointmentStatus;

function appointment(status: $Enums.AppointmentStatus) {
  return { status };
}

describe("CASCADABLE_STATUS", () => {
  it("is CONFIRMED — the only status §12 cascades on", () => {
    assert.equal(CASCADABLE_STATUS, S.CONFIRMED);
  });
});

describe("selectOnlyConfirmed", () => {
  it("keeps every CONFIRMED row", () => {
    const rows = [appointment(S.CONFIRMED), appointment(S.CONFIRMED)];
    assert.equal(selectOnlyConfirmed(rows).length, 2);
  });

  it("drops ARRIVED — an attended patient is never overwritten ([T])", () => {
    assert.equal(selectOnlyConfirmed([appointment(S.ARRIVED)]).length, 0);
  });

  it("drops COMPLETED and NO_SHOW — history is never rewritten ([T])", () => {
    assert.equal(selectOnlyConfirmed([appointment(S.COMPLETED)]).length, 0);
    assert.equal(selectOnlyConfirmed([appointment(S.NO_SHOW)]).length, 0);
  });

  it("drops CANCELLED and REJECTED — there is nothing left to cascade", () => {
    assert.equal(selectOnlyConfirmed([appointment(S.CANCELLED)]).length, 0);
    assert.equal(selectOnlyConfirmed([appointment(S.REJECTED)]).length, 0);
  });

  it("drops PENDING — a status that is never written must never look affected", () => {
    assert.equal(selectOnlyConfirmed([appointment(S.PENDING)]).length, 0);
  });

  it("mixes: one CONFIRMED survives among many inert rows", () => {
    const rows = [
      appointment(S.CANCELLED),
      appointment(S.ARRIVED),
      appointment(S.CONFIRMED),
      appointment(S.COMPLETED),
    ];
    assert.deepEqual(selectOnlyConfirmed(rows).map((row) => row.status), [S.CONFIRMED]);
  });
});

describe("isClinicCaused", () => {
  it("an appointment with no marker is not clinic-caused", () => {
    assert.equal(isClinicCaused({ doctorUnavailabilityId: null }), false);
  });

  it("a marked appointment is clinic-caused — regardless of its current status", () => {
    // A cancelled booking keeps its marker, so §17 can still classify it.
    assert.equal(isClinicCaused({ doctorUnavailabilityId: "0c000000-0000-4000-8000-000000000001" }), true);
  });
});

describe("assertValidDisruptionWindow", () => {
  it("accepts a window with positive length", () => {
    assert.doesNotThrow(() =>
      assertValidDisruptionWindow(new Date("2026-10-12T09:00:00.000Z"), new Date("2026-10-12T10:00:00.000Z")),
    );
  });

  it("refuses a zero-length window (end === start)", () => {
    assert.throws(
      () =>
        assertValidDisruptionWindow(new Date("2026-10-12T09:00:00.000Z"), new Date("2026-10-12T09:00:00.000Z")),
      (err: unknown) =>
        err instanceof AppError && err.status === 422 && err.code === "INVALID_WINDOW",
    );
  });

  it("refuses a negative-length window (end before start)", () => {
    assert.throws(
      () =>
        assertValidDisruptionWindow(new Date("2026-10-12T10:00:00.000Z"), new Date("2026-10-12T09:00:00.000Z")),
      (err: unknown) =>
        err instanceof AppError && err.status === 422 && err.code === "INVALID_WINDOW",
    );
  });
});