import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import {
  cancellationRefundKind,
  conversionFailureRefundKind,
  conversionFailureReleaseReason,
  refundNotificationType,
  remainingRefundablePaise,
} from "../src/lib/refundPolicy.js";
import { toGatewayRefundParams } from "../src/lib/paymentGateway.js";

describe("remainingRefundablePaise", () => {
  it("subtracts every committed refund from the captured amount", () => {
    assert.equal(remainingRefundablePaise(100_000, [{ amountPaise: 20_000 }, { amountPaise: 30_000 }]), 50_000);
  });

  it("counts PENDING, SUCCESS and FAILED alike — an owed refund is never spent twice", () => {
    assert.equal(remainingRefundablePaise(100_000, [{ amountPaise: 100_000 }]), 0);
  });

  it("never returns a negative amount", () => {
    assert.equal(remainingRefundablePaise(100_000, [{ amountPaise: 120_000 }]), 0);
  });
});

describe("cancellationRefundKind", () => {
  it("uses CLINIC_CAUSED for staff and admin cancellations", () => {
    assert.equal(
      cancellationRefundKind({ actorRole: $Enums.UserRole.STAFF, clinicCaused: false }),
      $Enums.RefundKind.CLINIC_CAUSED,
    );
    assert.equal(
      cancellationRefundKind({ actorRole: $Enums.UserRole.ADMIN, clinicCaused: false }),
      $Enums.RefundKind.CLINIC_CAUSED,
    );
  });

  it("uses CLINIC_CAUSED for a patient cancelling a clinic-caused booking", () => {
    assert.equal(
      cancellationRefundKind({ actorRole: $Enums.UserRole.PATIENT, clinicCaused: true }),
      $Enums.RefundKind.CLINIC_CAUSED,
    );
  });

  it("uses CANCELLATION for an ordinary patient cancellation inside the cutoff", () => {
    assert.equal(
      cancellationRefundKind({ actorRole: $Enums.UserRole.PATIENT, clinicCaused: false }),
      $Enums.RefundKind.CANCELLATION,
    );
  });
});

describe("conversionFailureRefundKind", () => {
  it("labels an expired hold EXPIRED_HOLD", () => {
    assert.equal(conversionFailureRefundKind("HOLD_EXPIRED"), $Enums.RefundKind.EXPIRED_HOLD);
  });

  it("labels a signed payment that could not become a booking CONVERSION_FAILED", () => {
    for (const code of ["ALREADY_BOOKED", "HOLD_RELEASED", "SLOT_FULL", "DOCTOR_UNAVAILABLE"]) {
      assert.equal(conversionFailureRefundKind(code), $Enums.RefundKind.CONVERSION_FAILED, code);
    }
  });

  it("does not refund a payment it cannot prove exists", () => {
    assert.equal(conversionFailureRefundKind("PAYMENT_NOT_FOUND"), null);
    assert.equal(conversionFailureRefundKind("PAYMENT_SIGNATURE_INVALID"), null);
  });
});

describe("conversionFailureReleaseReason", () => {
  it("releases an expired hold as EXPIRED and every other conversion failure as CONVERSION_FAILED", () => {
    assert.equal(
      conversionFailureReleaseReason($Enums.RefundKind.EXPIRED_HOLD),
      $Enums.SeatHoldReleaseReason.EXPIRED,
    );
    assert.equal(
      conversionFailureReleaseReason($Enums.RefundKind.CONVERSION_FAILED),
      $Enums.SeatHoldReleaseReason.CONVERSION_FAILED,
    );
  });
});

describe("refundNotificationType", () => {
  it("emails late-arriving money separately from an ordinary refund", () => {
    assert.equal(
      refundNotificationType($Enums.RefundKind.EXPIRED_HOLD),
      $Enums.NotificationType.PAYMENT_LATE_REFUND,
    );
    assert.equal(
      refundNotificationType($Enums.RefundKind.CANCELLATION),
      $Enums.NotificationType.REFUND_COMPLETED,
    );
  });
});

describe("toGatewayRefundParams", () => {
  it("passes paise and the local refund id through untouched", () => {
    const params = toGatewayRefundParams({
      paymentId: "pay_123",
      amountPaise: 49_900,
      currency: "INR",
      refundId: "01999f2e-7b1a-7000-8000-000000000001",
    });
    assert.deepEqual(params, {
      paymentId: "pay_123",
      amountPaise: 49_900,
      currency: "INR",
      refundId: "01999f2e-7b1a-7000-8000-000000000001",
    });
  });
});
