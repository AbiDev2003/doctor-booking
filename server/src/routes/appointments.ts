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
  listAppointmentsQuerySchema,
  rejectAppointmentSchema,
  rescheduleAppointmentSchema,
} from "../schemas/appointments.js";
import { createDeskBookingSchema, deskQueueQuerySchema } from "../schemas/staff.js";
import { bookAppointment } from "../services/appointments/booking.service.js";
import { bookAtDesk } from "../services/staff/deskBooking.service.js";
import { listDeskQueue } from "../services/staff/staffDesk.service.js";
import {
  getPatientAppointment,
  listPatientAppointments,
  previewCancellation,
} from "../services/appointments/patientAppointments.service.js";
import {
  arriveAppointment,
  cancelAppointment,
  completeAppointment,
  markNoShow,
  rejectAppointment,
} from "../services/appointments/appointmentTransition.service.js";
import { rescheduleAppointment } from "../services/appointments/reschedule.service.js";
import { kickRefundWorker } from "../services/payments/refund.service.js";
import type { ActorContext } from "../services/doctors/doctor.service.js";

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
 *   POST /api/v1/appointments/:id/reschedule  same row → new slot (PATIENT own+same doctor / ADMIN / STAFF)
 *
 * **Booking is PATIENT only.** Pay-at-clinic self-booking is Day 19's scope; the
 * desk actor (STAFF/ADMIN booking on a patient's behalf) is Day 32's walk-in
 * flow. The service re-enforces the role too, so a route wired in the wrong
 * order cannot open it up (Day 12's double-enforcement).
 *
 * **Transitions follow §13's matrix.** The attendance verbs are ADMIN/STAFF
 * (Doctors may view the queue but never change attendance, §13.1); cancel is
 * open to a patient for their own booking plus ADMIN/STAFF. **Reschedule is not
 * a transition** — it moves the same row to a new slot (§14), so it has its own
 * route and its own service; a patient stays within the same doctor, staff may
 * cross, and the fee delta is settled inside the service (§14/§17).
 * The matrix itself — including "no `COMPLETED` straight from `CONFIRMED`" and
 * terminal states — is enforced in the pure `lib/transitionGuard.ts` inside each
 * service transaction, not here: the route's job is the coarse role gate and the
 * mandatory reason.
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
const rescheduleAllowed = requireRole($Enums.UserRole.PATIENT, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

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

/* ------------------------------------------------------------------ */
/* Day 30 — the patient dashboard's read surface                       */
/* ------------------------------------------------------------------ */

/** GET / — the signed-in patient's own appointments (`?scope=upcoming|past|all`). */
appointmentsRouter.get("/", patientOnly, async (req, res, next) => {
  try {
    const { scope } = listAppointmentsQuerySchema.parse(req.query);
    const result = await listPatientAppointments({ patientId: authenticatedUser(req).id, scope });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Day 32 — the front desk's read + walk-in surface                    */
/* ------------------------------------------------------------------ */

/**
 * GET /desk — the whole clinic day: every doctor's slots and their queues,
 * with the server-computed action flags. Registered before `/:id` so the
 * literal path is never parsed as an appointment id.
 */
appointmentsRouter.get("/desk", staffOnly, async (req, res, next) => {
  try {
    const { date } = deskQueueQuerySchema.parse(req.query);
    res.json({ queue: await listDeskQueue(date) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /desk — create-or-find the patient by phone, then book the slot. The
 * body carries the slot and the identity; fee, doctor, capacity and status are
 * all derived inside the transaction (§16/§29).
 */
appointmentsRouter.post("/desk", staffOnly, async (req, res, next) => {
  try {
    const parsed = createDeskBookingSchema.parse(req.body);
    const result = await bookAtDesk({
      actor: actorOf(req),
      slotId: parsed.slotId,
      patient: parsed.patient,
      ...requestMeta(req, res),
    });
    res.status(201).json({
      message: result.createdPatient ? "Walk-in patient created and booked." : "Walk-in booking created.",
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /:id — one of the patient's own appointments (deep link on the dashboard). */
appointmentsRouter.get("/:id", patientOnly, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const appointment = await getPatientAppointment({ appointmentId: id, patientId: authenticatedUser(req).id });
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id/refund-preview — the cancel dialog's server-side answer (§17).
 * Writes nothing; the cancel route remains the only mutation.
 */
appointmentsRouter.get("/:id/refund-preview", patientOnly, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const preview = await previewCancellation({ appointmentId: id, patientId: authenticatedUser(req).id });
    res.json({ preview });
  } catch (err) {
    next(err);
  }
});

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
    kickRefundWorker();
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
    kickRefundWorker();
    res.status(200).json({ message: "Appointment cancelled.", appointment });
  } catch (err) {
    next(err);
  }
});

/** POST /:id/reschedule — move the same row to a new slot (§14); a patient stays with the same doctor. */
appointmentsRouter.post("/:id/reschedule", rescheduleAllowed, async (req, res, next) => {
  try {
    const { id } = appointmentIdParamSchema.parse(req.params);
    const { slotId, reason } = rescheduleAppointmentSchema.parse(req.body);
    const appointment = await rescheduleAppointment({
      actor: actorOf(req),
      appointmentId: id,
      slotId,
      reason: reason ?? null,
      ...requestMeta(req, res),
    });
    kickRefundWorker();
    res.status(200).json({ message: "Appointment rescheduled.", appointment });
  } catch (err) {
    next(err);
  }
});
