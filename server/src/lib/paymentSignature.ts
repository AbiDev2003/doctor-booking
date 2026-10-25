import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * plan.md §17 / verification — the two signatures, one pure module (Day 24).
 *
 * Both verifications the plan asks for live here as functions over strings:
 * nothing reads config, touches the database or sees a request, so the known
 * HMAC vectors in `tests/paymentSignature.test.ts` pin them exactly the way
 * `lib/fee.ts` and `lib/paymentGateway.ts` are pinned — with no `.env` and no
 * network.
 *
 *   1. THE CHECKOUT SIGNATURE (browser verify): Razorpay hands the browser
 *      `order_id + payment_id + signature` where
 *      `signature = HMAC_SHA256(order_secret, order_id + "|" + payment_id)`.
 *      Recomputing it with the SECRET KEY and comparing is what proves the
 *      payment is genuine — the browser is never trusted on its word (§17
 *      "never trust payment success solely from frontend input").
 *
 *   2. THE WEBHOOK SIGNATURE: `HMAC_SHA256(webhook_secret, raw_body)` compared
 *      against `X-Razorpay-Signature` — over the RAW bytes, which is why the
 *      webhook route is mounted under `express.raw` before any JSON parser
 *      (app.ts): re-serializing a parsed object would change the bytes and
 *      every signature would fail.
 *
 * Comparisons are `timingSafeEqual` on equal-length buffers, and length is
 * checked first: a `===` on hex strings is a byte-by-byte early-exit that
 * leaks the prefix of a valid signature to an attacker who can measure the
 * comparison. A mismatch is a boolean `false`, never an exception — a bad
 * signature is a routine answer on this path, not a crash.
 */

/** `HMAC_SHA256(secret, orderId + "|" + paymentId)` as lowercase hex — the checkout signature. */
export function computePaymentSignature(secret: string, orderId: string, paymentId: string): string {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** True when the browser-submitted triple carries the genuine checkout signature. */
export function verifyPaymentSignature(input: {
  readonly secret: string;
  readonly orderId: string;
  readonly paymentId: string;
  readonly signature: string;
}): boolean {
  if (input.signature.length !== 64) return false;
  return safeEquals(computePaymentSignature(input.secret, input.orderId, input.paymentId), input.signature);
}

/** True when the webhook's `X-Razorpay-Signature` matches `HMAC_SHA256(secret, rawBody)`. */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly rawBody: Buffer;
  readonly signature: string;
}): boolean {
  if (input.signature.length !== 64) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  return safeEquals(expected, input.signature);
}
