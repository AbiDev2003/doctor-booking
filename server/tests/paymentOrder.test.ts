import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveConsultationFee } from "../src/lib/fee.js";
import { toGatewayOrderParams } from "../src/lib/paymentGateway.js";

/**
 * Day 23 — the pure money layer of §17's first half, pinned without a
 * database, a network call or a Razorpay key (`npm test` stays key-free;
 * `scripts/day23-dod.ts` is the real-gateway half and skips without keys).
 *
 * Two claims matter here, and both are drift-prevention rather than arithmetic:
 *
 *   - the order amount is derived by the SAME function the booking transaction
 *     writes into `feeAmount` (lib/fee.ts), so "what the patient was charged"
 *     and "what the appointment says they agreed to" cannot diverge;
 *   - paise reach the gateway untouched — one float coercion anywhere in this
 *     path is the Phase-6 symptom of a Phase-1 cause (schema.prisma: Payment).
 */

describe("deriveConsultationFee", () => {
  it("prefers the doctor's own fee over the clinic default", () => {
    assert.equal(deriveConsultationFee(120_000, 50_000), 120_000);
  });

  it("falls back to the clinic default when the profile has no fee set", () => {
    assert.equal(deriveConsultationFee(null, 50_000), 50_000);
    assert.equal(deriveConsultationFee(undefined, 50_000), 50_000);
  });

  it("keeps a deliberately free profile at 0 — `??`, not `||`", () => {
    // A zero profile is a decision, not missing data. The number reaching the
    // payment row is still refused there (422 ZERO_CONSULTATION_FEE) because
    // `CHECK (amount_paise > 0)` would refuse it anyway; that wall belongs to
    // the service, not the derivation.
    assert.equal(deriveConsultationFee(0, 50_000), 0);
  });
});

describe("toGatewayOrderParams", () => {
  const uuid7 = "01999f2e-7b1a-7000-8000-000000000001";

  it("passes paise through as integer subunits — no conversion in either direction", () => {
    const params = toGatewayOrderParams({ paymentId: uuid7, amountPaise: 49_900, currency: "INR" });
    assert.equal(params.amountPaise, 49_900);
    assert.ok(Number.isInteger(params.amountPaise));
    assert.equal(params.currency, "INR");
  });

  it("receipts the order with the local payment id, so every gateway order traces to one row", () => {
    const params = toGatewayOrderParams({ paymentId: uuid7, amountPaise: 1, currency: "INR" });
    assert.equal(params.receipt, uuid7);
  });

  it("keeps the receipt inside Razorpay's 40-character cap", () => {
    // uuid(7) is 36 characters. If the id format ever grows past 40 this test
    // fails at the seam instead of at a gateway 400 nobody sees locally.
    const params = toGatewayOrderParams({ paymentId: uuid7, amountPaise: 1, currency: "INR" });
    assert.ok(params.receipt.length <= 40, `receipt is ${params.receipt.length} characters`);
  });
});
