import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import { createPaymentOrderSchema } from "../schemas/payments.js";
import { createPaymentOrder } from "../services/paymentOrder.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §17 — the online-payment surface (Day 23).
 *
 *   POST /api/v1/payments/orders   create a Razorpay order for a slot (201)
 *
 * One route today; Day 24 adds the verify/conversion siblings beside it rather
 * than inside this body, and Day 25 the refund-facing ones. **PATIENT only**,
 * gated here by the role middleware and again inside the service (Day 12's
 * double-enforcement), because an order is money-shaped and a miswired route on
 * a money endpoint is the expensive kind of bug.
 *
 * The body is a bare `slotId` (schemas/payments.ts): the actor is `req.user`
 * and the amount is the server's `deriveConsultationFee` answer — the client
 * never sends a price (§3.4).
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

/** POST /orders — the `PENDING` payment + gateway order a checkout opens with (§17 step 1, first half). */
paymentsRouter.post("/orders", patientOnly, async (req, res, next) => {
  try {
    const { slotId } = createPaymentOrderSchema.parse(req.body);
    const order = await createPaymentOrder({ actor: actorOf(req), slotId, ...requestMeta(req, res) });
    res.status(201).json({ message: "Payment order created.", order });
  } catch (err) {
    next(err);
  }
});
