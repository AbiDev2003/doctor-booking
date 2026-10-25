import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { config } from "../config.js";
import { AppError } from "../lib/appError.js";
import { logger } from "../lib/logger.js";
import { getClientIp } from "../lib/clientIp.js";
import { verifyPaymentSignature, verifyWebhookSignature } from "../lib/paymentSignature.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import { createPaymentOrderSchema, verifyPaymentSchema } from "../schemas/payments.js";
import { createPaymentOrder } from "../services/paymentOrder.service.js";
import { convertPayment } from "../services/paymentConvert.service.js";
import { kickRefundWorker } from "../services/refund.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §17 — the online-payment surface (Day 23 order, Day 24 verify).
 *
 *   POST /api/v1/payments/orders   seat hold + Razorpay order (201)
 *   POST /api/v1/payments/verify   checkout triple → converted booking (200)
 *   POST /api/v1/payments/webhook  Razorpay's own report of the same event (200)
 *
 * All three converge on one conversion function; the two edges differ only in
 * HOW THEY PROVE THE PAYMENT — the browser proves it with the checkout
 * signature over the key secret, the webhook proves it with the raw-body
 * signature over the webhook secret (both checks live here, in front of the
 * service, because both are I/O facts about the request). PATIENT-only on the
 * first two, gated by the role middleware and again inside the order service
 * (Day 12's double-enforcement); the webhook is unauthenticated BY NATURE —
 * Razorpay has no session — and is authenticated instead by its signature.
 *
 * The order body is a bare `slotId` (schemas/payments.ts): the actor is
 * `req.user` and the amount is the server's `deriveConsultationFee` answer —
 * the client never sends a price (§3.4). The verify body is the gateway's own
 * triple, passed through untouched and trusted only after recomputation.
 */
export const paymentsRouter = Router();

paymentsRouter.use(requireAuth);

const patientOnly = requireRole($Enums.UserRole.PATIENT);

/** The `req.user` behind `requireAuth`, or a 401 if a future route miswires (pattern: routes/appointments.ts). */
function authenticatedUser(req: Request): NonNullable<Request["user"]> {
  if (!req.user) {
    throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  }
  return req.user;
}

function actorOf(req: Request): ActorContext {
  const user = authenticatedUser(req);
  return { id: user.id, role: user.role, name: user.name };
}

/** Every mutation carries §20's ip/requestId; assembled once per route. */
function requestMeta(req: Request, res: Response): { ip: string | null; requestId: string } {
  return { ip: getClientIp(req), requestId: getRequestId(res) };
}

/** POST /orders — §8.6's seat hold + the gateway order the checkout opens with (§17 step 1). */
paymentsRouter.post("/orders", patientOnly, async (req, res, next) => {
  try {
    const { slotId } = createPaymentOrderSchema.parse(req.body);
    const order = await createPaymentOrder({ actor: actorOf(req), slotId, ...requestMeta(req, res) });
    res.status(201).json({ message: "Payment order created.", order });
  } catch (err) {
    next(err);
  }
});

/** POST /verify — §17 steps 3–5 from the browser's side of the checkout. */
paymentsRouter.post("/verify", patientOnly, async (req, res, next) => {
  try {
    const body = verifyPaymentSchema.parse(req.body);

    const keySecret = config.RAZORPAY_KEY_SECRET;
    if (keySecret === undefined) {
      // No secret, no verification — same honest 503 as the order route, and
      // the webhook (which needs a different secret) is no substitute for it.
      throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Online payments are not configured yet.");
    }

    // §17 step 3, literally: recompute HMAC_SHA256(secret, order_id + "|" +
    // payment_id) and compare — the browser's word is never the proof.
    const genuine = verifyPaymentSignature({
      secret: keySecret,
      orderId: body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    });
    if (!genuine) {
      throw new AppError(400, "PAYMENT_SIGNATURE_INVALID", "The payment could not be verified.");
    }

    const actor = actorOf(req);
    const appointment = await convertPayment({
      orderId: body.razorpay_order_id,
      gatewayPaymentId: body.razorpay_payment_id,
      expectedPatientId: actor.id,
      actor,
      ...requestMeta(req, res),
    });
    kickRefundWorker();
    res.json({ message: "Payment verified.", appointment });
  } catch (err) {
    kickRefundWorker();
    next(err);
  }
});

/**
 * POST /webhook — Razorpay reports `order.paid` here (§17 step 5's other
 * entry point).
 *
 * NO `requireAuth`: the caller is a Razorpay server, and its authentication is
 * `X-Razorpay-Signature` over the RAW body — which is why app.ts mounts
 * `express.raw` on this path before any JSON parser. The secret is
 * `RAZORPAY_WEBHOOK_SECRET` (the dashboard's), never the key secret.
 *
 * Response policy: a signature-valid request is ACKNOWLEDGED with 200 even
 * when the conversion rejects (expired hold, duplicate, …) — Razorpay retries
 * non-2xx forever, and retrying an expired hold will never convert it; the
 * rejection is logged, Day 25 has already turned captured-but-unbooked money
 * into a queued refund, and the worker kick tries to execute it. A non-AppError
 * (the database being down) still surfaces as a 500 so the retry DOES make
 * sense there.
 */
paymentsRouter.post("/webhook", async (req, res, next) => {
  try {
    const secret = config.RAZORPAY_WEBHOOK_SECRET;
    if (secret === undefined) {
      throw new AppError(503, "WEBHOOK_NOT_CONFIGURED", "Webhook verification is not configured.");
    }

    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      // Reached when the content-type was not application/json: nothing
      // signed a body, because nothing arrived as one.
      throw new AppError(400, "WEBHOOK_BODY_INVALID", "Webhook body must be the signed JSON payload.");
    }

    const signature = req.get("x-razorpay-signature") ?? "";
    if (!verifyWebhookSignature({ secret, rawBody, signature })) {
      throw new AppError(403, "WEBHOOK_SIGNATURE_INVALID", "Webhook signature mismatch.");
    }

    let event: { event?: unknown; payload?: { payment?: { entity?: { order_id?: unknown; id?: unknown } } } };
    try {
      event = JSON.parse(rawBody.toString("utf8")) as typeof event;
    } catch {
      logger.warn("razorpay webhook arrived with an unparsable body");
      res.json({ status: "ignored" });
      return;
    }

    if (event.event !== "order.paid") {
      // Acknowledge events we do not act on so Razorpay stops redelivering them.
      res.json({ status: "ignored" });
      return;
    }

    const entity = event.payload?.payment?.entity;
    const orderId = typeof entity?.order_id === "string" ? entity.order_id : null;
    const paymentId = typeof entity?.id === "string" ? entity.id : null;
    if (orderId === null || paymentId === null) {
      logger.warn({ event: event.event }, "order.paid webhook without order/payment ids");
      res.json({ status: "ignored" });
      return;
    }

    try {
      await convertPayment({
        orderId,
        gatewayPaymentId: paymentId,
        actor: { name: "system" },
        ...requestMeta(req, res),
      });
      kickRefundWorker();
      res.json({ status: "processed" });
    } catch (err) {
      if (err instanceof AppError) {
        // Signature-valid but not convertible: 200 ends the retry loop; the
        // log carries the reason and the settlement has queued any refund.
        logger.warn({ code: err.code, orderId, paymentId }, "webhook conversion rejected");
        kickRefundWorker();
        res.json({ status: "rejected", code: err.code });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});
