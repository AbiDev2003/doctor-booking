import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import {
  appointmentIdParamSchema,
  cancelAppointmentSchema,
  createBookingSchema,
  rejectAppointmentSchema,
} from "../schemas/appointments.js";
import { bookAppointment } from "../services/booking.service.js";
import {
  arriveAppointment,
  cancelAppointment,
  completeAppointment,
  markNoShow,
  rejectAppointment,
} from "../services/appointmentTransition.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §8.1 / §13 / §13.1 / §15 — the booking and status-transition surface
 * (booking Day 19; transitions Day 21).
 *
 *   POST /api/v1/appointments           create one CONFIRMED booking (201)
 *   POST /api/v1/appointments/:id/arrive    CONFIRMED → ARRIVED  (ADMIN, STAFF)
 *   POST /api/v1/appointments/:id/complete  ARRIVED  → COMPLETED (ADMIN, STAFF)
 *   POST /api/v1/appointments/:id/no-show   CONFIRMED → NO_SHOW  (ADMIN, STAFF)
 *   POST /api/v1/appointments/:id/reject    CONFIRMED → REJECTED (ADMIN, STAFF, reason)
 *   POST /api/v1/appointments/:id/cancel    … → CANCELLED        (PATIENT own / ADMIN / STAFF)
 *
 * **Booking is PATIENT only.** Pay-at-clinic self-booking is Day 19's scope; the
 * desk actor (STAFF/ADMIN booking on a patient's behalf) is Day 32's walk-in
 * flow. The service re-enforces the role too, so a route wired in the wrong
 * order cannot open it up (Day 12's double-enforcement).
 *
 * **Transitions follow §13's matrix.** The attendance verbs are ADMIN/STAFF
 * (Doctors may view the queue but never change attendance, §13.1); cancel is
 * open to a patient for their own booking plus ADMIN/STAFF. The matrix itself —
 * including "no `COMPLETED` straight from `CONFIRMED`" and terminal states — is
 * enforced in the pure `lib/transitionGuard.ts` inside each service transaction,
 * not here: the route's job is the coarse role gate and the mandatory reason.
 *
 * The booking body carries only a `slotId` (`schemas/appointments.ts`): the
 * patient is `req.user`, and the doctor, fee and status are all derived
 * server-side inside the transaction.
 */
export const appointmentsRouter = Router();

appointmentsRouter.use(requireAuth);

const patientOnly = requireRole($Enums.UserRole.PATIENT);
const staffOnly = requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);
const cancelAllowed = requireRole($Enums.UserRole.PATIENT, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

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

/* ------------------------------------------------------------------ */
/* §13/§13.1 — status transitions (Day 21)                             */
/* ------------------------------------------------------------------ */

/** POST /:id/arrive — check the patient in (§13.1, from the slot's start). */
appointmentsRouter.post("/:id/arrive", staffOnly, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const appointment = await arriveAppointment({ actor: actorOf(req), appointmentId: id, ...requestMeta(req, res) });
    res.status(200).json({ message: "Patient checked in.", appointment });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/complete — close the consultation (§13.1, only from ARRIVED). */
appointmentsRouter.post("/:id/complete", staffOnly, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const appointment = await completeAppointment({ actor: actorOf(req), appointmentId: id, ...requestMeta(req, res) });
    res.status(200).json({ message: "Consultation completed.", appointment });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/no-show — record the patient as absent (§13.1, only after the slot's end). */
appointmentsRouter.post("/:id/no-show", staffOnly, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const appointment = await markNoShow({ actor: actorOf(req), appointmentId: id, ...requestMeta(req, res) });
    res.status(200).json({ message: "Appointment marked no-show.", appointment });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/reject — refuse the booking at the desk; reason is MANDATORY (§13). */
appointmentsRouter.post("/:id/reject", staffOnly, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const { reason } = rejectAppointmentSchema.parse(req.body);
    const appointment = await rejectAppointment({
      actor: actorOf(req),
      appointmentId: id,
      reason,
      ...requestMeta(req, res),
    });
    res.status(200).json({ message: "Booking rejected.", appointment });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/cancel — a patient their own (before the §8.5 cutoff); staff any (reason mandatory). */
appointmentsRouter.post("/:id/cancel", cancelAllowed, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const { reason } = cancelAppointmentSchema.parse(req.body);
    const appointment = await cancelAppointment({
      actor: actorOf(req),
      appointmentId: id,
      reason: reason ?? null,
      ...requestMeta(req, res),
    });
    res.status(200).json({ message: "Appointment cancelled.", appointment });
  } catch (err) {
    next(err);
  }
});
