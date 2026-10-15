import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import { createBookingSchema } from "../schemas/appointments.js";
import { bookAppointment } from "../services/booking.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §8.1 / §13 / §15 — the booking surface, Day 19.
 *
 *   POST /api/v1/appointments   create one CONFIRMED booking (201)
 *
 * **PATIENT only.** Pay-at-clinic self-booking is this day's scope; the desk
 * actor (STAFF/ADMIN booking on a patient's behalf) is Day 32's walk-in flow.
 * The service re-enforces the role too, so a route wired in the wrong order
 * cannot open it up (Day 12's double-enforcement).
 *
 * The body carries only a `slotId` (`schemas/appointments.ts`): the patient is
 * `req.user`, and the doctor, fee and status are all derived server-side inside
 * the transaction.
 */
export const appointmentsRouter = Router();

appointmentsRouter.use(requireAuth);

const patientOnly = requireRole($Enums.UserRole.PATIENT);

/** The `req.user` behind `requireAuth`, or a 401 if a future route miswires (pattern: routes/slots.ts). */
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

appointmentsRouter.post("/", patientOnly, async (req, res, next) => {
  try {
    const { slotId } = createBookingSchema.parse(req.body);
    const appointment = await bookAppointment({ actor: actorOf(req), slotId, ...requestMeta(req, res) });
    res.status(201).json({ message: "Appointment booked.", appointment });
  } catch (err) {
    next(err);
  }
});
