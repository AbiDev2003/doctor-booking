import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { computePaymentSignature, verifyPaymentSignature, verifyWebhookSignature } from "../src/lib/paymentSignature.js";

/**
 * Day 24 — the §17 signature seam, pure (decision: verify both secrets with
 * one helper module). These are the exact contracts `/payments/verify` and
 * `/payments/webhook` rest on: the HMAC is SHA-256 hex over
 * `order_id|payment_id` for checkout verification, and over the RAW body bytes
 * for webhooks. Vectors are pinned here (not recomputed from the impl under
 * test) so a refactor of the helper cannot silently redefine "correct" — the
 * DoD script's fabricated signature uses the same construction against the
 * real test-key secret.
 */
const CHECKOUT_SECRET = "s3cr3t";
const CHECKOUT_MESSAGE = "order_abc|pay_xyz";
// HMAC-SHA256(CHECKOUT_SECRET, CHECKOUT_MESSAGE) — pinned independently.
const CHECKOUT_HEX = "ee21698235c31aef5bb049b86d1c00014db7de75dbe78cb4ed9ffa8e90855655";

const WEBHOOK_SECRET = "whsec_demo";
const WEBHOOK_BODY = Buffer.from('{"event":"order.paid"}');
const WEBHOOK_HEX = "55d42c273a0afb20b444178e01ad5e16701471edb0f956e334c62899a4c6eb26";

describe("computePaymentSignature", () => {
  it("is HMAC-SHA256 hex over `order_id|payment_id`", () => {
    const message = "order_abc|pay_xyz";
    const expected = createHmac("sha256", CHECKOUT_SECRET).update(message).digest("hex");
    assert.equal(computePaymentSignature(CHECKOUT_SECRET, "order_abc", "pay_xyz"), expected);
    assert.equal(computePaymentSignature(CHECKOUT_SECRET, "order_abc", "pay_xyz"), CHECKOUT_HEX);
  });

  it("the pipe separator is NOT optional — a pair that concatenates differently must differ", () => {
    // "ab"+"cd" === "abcd" without the separator; with it the inputs are unique.
    assert.notEqual(computePaymentSignature(CHECKOUT_SECRET, "ab", "cd"), computePaymentSignature(CHECKOUT_SECRET, "abcd", ""));
    assert.notEqual(computePaymentSignature(CHECKOUT_SECRET, "a", "bc"), computePaymentSignature(CHECKOUT_SECRET, "ab", "c"));
  });
});

describe("verifyPaymentSignature — §17 step 3", () => {
  it("accepts the exact triple the gateway would sign", () => {
    assert.equal(
      verifyPaymentSignature({
        secret: CHECKOUT_SECRET,
        orderId: "order_abc",
        paymentId: "pay_xyz",
        signature: CHECKOUT_HEX,
      }),
      true,
    );
  });

  it("rejects a tampered signature", () => {
    const flipped = (CHECKOUT_HEX[0] === "e" ? "f" : "e") + CHECKOUT_HEX.slice(1);
    assert.equal(
      verifyPaymentSignature({ secret: CHECKOUT_SECRET, orderId: "order_abc", paymentId: "pay_xyz", signature: flipped }),
      false,
    );
  });

  it("rejects a signature of the wrong length without ever comparing", () => {
    assert.equal(
      verifyPaymentSignature({ secret: CHECKOUT_SECRET, orderId: "order_abc", paymentId: "pay_xyz", signature: CHECKOUT_HEX.slice(0, 32) }),
      false,
    );
    assert.equal(
      verifyPaymentSignature({ secret: CHECKOUT_SECRET, orderId: "order_abc", paymentId: "pay_xyz", signature: "" }),
      false,
    );
  });

  it("rejects a valid signature replayed against a different payment pair", () => {
    // The classic failure: sign order A / pay A, present it as order A / pay B.
    assert.equal(
      verifyPaymentSignature({ secret: CHECKOUT_SECRET, orderId: "order_abc", paymentId: "pay_OTHER", signature: CHECKOUT_HEX }),
      false,
    );
  });

  it("rejects a signature made with a different secret", () => {
    const wrongSecret = createHmac("sha256", "other-secret").update(CHECKOUT_MESSAGE).digest("hex");
    assert.equal(
      verifyPaymentSignature({ secret: CHECKOUT_SECRET, orderId: "order_abc", paymentId: "pay_xyz", signature: wrongSecret }),
      false,
    );
  });
});

describe("verifyWebhookSignature — raw-body HMAC (§17)", () => {
  it("accepts the HMAC over the exact raw bytes", () => {
    assert.equal(verifyWebhookSignature({ secret: WEBHOOK_SECRET, rawBody: WEBHOOK_BODY, signature: WEBHOOK_HEX }), true);
  });

  it("rejects the same logical body re-serialized differently", () => {
    // HMAC is byte-exact: whitespace/order differences are a different message.
    assert.equal(verifyWebhookSignature({ secret: WEBHOOK_SECRET, rawBody: Buffer.from('{"event": "order.paid"}'), signature: WEBHOOK_HEX }), false);
  });

  it("rejects tampered bodies, wrong lengths, wrong secrets", () => {
    const flipped = (WEBHOOK_HEX[0] === "5" ? "6" : "5") + WEBHOOK_HEX.slice(1);
    assert.equal(verifyWebhookSignature({ secret: WEBHOOK_SECRET, rawBody: WEBHOOK_BODY, signature: flipped }), false);
    assert.equal(verifyWebhookSignature({ secret: WEBHOOK_SECRET, rawBody: WEBHOOK_BODY, signature: WEBHOOK_HEX.slice(0, 10) }), false);
    assert.equal(verifyWebhookSignature({ secret: "not-the-secret", rawBody: WEBHOOK_BODY, signature: WEBHOOK_HEX }), false);
  });

  it("a signature made with the checkout KEY_SECRET fails on the webhook path", () => {
    // The two secrets are different credentials in production; a gateway event
    // signed (hypothetically) with the key secret must not clear webhook auth.
    const checkoutStyle = createHmac("sha256", CHECKOUT_SECRET).update(WEBHOOK_BODY).digest("hex");
    assert.equal(verifyWebhookSignature({ secret: WEBHOOK_SECRET, rawBody: WEBHOOK_BODY, signature: checkoutStyle }), false);
  });
});
