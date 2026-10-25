import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { resolveCollectedAmount } from "../src/lib/offlinePayment.js";
import {
  collectOfflinePaymentSchema,
  completeHandBackSchema,
  voidOfflinePaymentSchema,
} from "../src/schemas/payments.js";

/**
 * Day 26 — the pure edge of the desk money flow, pinned without a database.
 * The database-backed half is `scripts/day26-dod.ts`.
 */

describe("resolveCollectedAmount", () => {
  it("defaults to the full outstanding fee", () => {
    assert.equal(resolveCollectedAmount(75_000), 75_000);
  });

  it("accepts a deliberate concession below the fee", () => {
    assert.equal(resolveCollectedAmount(75_000, 60_000), 60_000);
  });

  it("refuses more than the outstanding fee", () => {
    assert.throws(
      () => resolveCollectedAmount(75_000, 75_001),
      (err: unknown) => err instanceof AppError && err.code === "AMOUNT_EXCEEDS_FEE",
    );
  });

  it("refuses zero, negative and fractional paise", () => {
    for (const amount of [0, -1, 1.5]) {
      assert.throws(
        () => resolveCollectedAmount(75_000, amount),
        (err: unknown) => err instanceof AppError && err.code === "INVALID_AMOUNT",
      );
    }
  });
});

describe("offline payment request schemas", () => {
  const appointmentId = "01999f2e-7b1a-7000-8000-000000000001";

  it("accepts CASH, CARD and UPI collection with an optional actual amount", () => {
    for (const method of [
      $Enums.PaymentMethod.CASH,
      $Enums.PaymentMethod.CARD,
      $Enums.PaymentMethod.UPI,
    ]) {
      const parsed = collectOfflinePaymentSchema.parse({ appointmentId, method, amountPaise: 100 });
      assert.equal(parsed.method, method);
      assert.equal(parsed.amountPaise, 100);
    }
    assert.equal(collectOfflinePaymentSchema.parse({ appointmentId, method: "CASH" }).amountPaise, undefined);
  });

  it("refuses a non-positive or fractional collection amount at the edge", () => {
    for (const amountPaise of [0, -1, 1.5]) {
      assert.throws(() => collectOfflinePaymentSchema.parse({ appointmentId, method: "CASH", amountPaise }));
    }
  });

  it("requires a reason when voiding an unpaid receivable", () => {
    assert.throws(() => voidOfflinePaymentSchema.parse({ appointmentId, reason: "   " }));
    assert.equal(voidOfflinePaymentSchema.parse({ appointmentId, reason: "Duplicate booking" }).reason, "Duplicate booking");
  });

  it("allows CASH and UPI hand-backs but never CARD", () => {
    assert.equal(completeHandBackSchema.parse({ method: "CASH" }).method, $Enums.PaymentMethod.CASH);
    assert.equal(completeHandBackSchema.parse({ method: "UPI" }).method, $Enums.PaymentMethod.UPI);
    assert.throws(() => completeHandBackSchema.parse({ method: "CARD" }));
  });
});
