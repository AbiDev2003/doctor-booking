import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { requireSelfOrRole } from "../lib/ownership.js";
import { getRequestId } from "../middleware/requestId.js";
import {
  createUnavailabilitySchema,
  listUnavailabilitiesQuerySchema,
  removeUnavailabilitySchema,
  unavailabilityIdParamSchema,
} from "../schemas/unavailability.js";
import {
  createDoctorUnavailability,
  listDoctorUnavailabilities,
  removeDoctorUnavailability,
} from "../services/unavailability.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §12 — the DoctorUnavailability write surface, Day 18.
 *
 * Mounted at `/api/v1/unavailabilities`:
 *
 * - `GET    /?doctorId=…`   list one doctor's disruptions
 * - `POST   /`              mark one doctor unavailable (201)
 * - `DELETE /:id`           remove one disruption (mandatory reason)
 *
 * **Roles.** ADMIN and STAFF manage any doctor's unavailability; a DOCTOR only
 * their own — the schedule-router pattern (decision 2, Day 15): the
 * `requireRole(DOCTOR, ADMIN, STAFF)` gate admits the three, then
 * `requireSelfOrRole` splits ownership where the target doctor is visible (GET
 * query and POST body). For DELETE the owning doctor lives on the row, so the
 * service does the ownership check (the schedules.ts PATCH/DELETE precedent).
 *
 * The route gates alone are not the authority — Day 12's double-enforcement:
 * the service re-checks role and ownership regardless of this composition.
 */
export const unavailabilitiesRouter = Router();

unavailabilitiesRouter.use(requireAuth);

const selfOrStaff = requireRole($Enums.UserRole.DOCTOR, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

/** The `req.user` behind `requireAuth`, or a 401 if a future route miswires (pattern: routes/doctors.ts). */
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
/* §12 — reads and writes                                              */
/* ------------------------------------------------------------------ */

/**
 * GET — one doctor's disruptions. ADMIN/STAFF read anyone; a DOCTOR reads only
 * their own (schedules.ts GET pattern).
 */
unavailabilitiesRouter.get("/", selfOrStaff, async (req, res, next) => {
  try {
    const { doctorId } = listUnavailabilitiesQuerySchema.parse(req.query);
    requireSelfOrRole(req, doctorId, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);
    res.status(200).json({ unavailabilities: await listDoctorUnavailabilities(doctorId, actorOf(req)) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST — mark a doctor unavailable. The scheduled doctor is the body's
 * `doctorId`, so ownership is decided here the same way schedules POST does;
 * the service re-runs the §12 cascade inside the disruption's transaction and
 * reports how many existing CONFIRMED bookings were flagged.
 */
unavailabilitiesRouter.post("/", selfOrStaff, async (req, res, next) => {
  try {
    const parsed = createUnavailabilitySchema.parse(req.body);
    requireSelfOrRole(req, parsed.doctorId, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

    const result = await createDoctorUnavailability({
      actor: actorOf(req),
      doctorId: parsed.doctorId,
      date: parsed.date,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      reason: parsed.reason,
      ...requestMeta(req, res),
    });

    res.status(201).json({ message: "Doctor marked unavailable.", ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE — remove one disruption (reopening the hidden slots through the read
 * model). The owning doctor is on the row, so the service enforces ownership;
 * this route's job is the gate and the mandatory reason.
 */
unavailabilitiesRouter.delete("/:id", selfOrStaff, async (req, res, next) => {
  try {
    const { id } = unavailabilityIdParamSchema.parse(req.params);
    const { reason } = removeUnavailabilitySchema.parse(req.body);

    await removeDoctorUnavailability({
      actor: actorOf(req),
      unavailabilityId: id,
      reason,
      ...requestMeta(req, res),
    });

    res.status(200).json({ message: "Unavailability removed." });
  } catch (err) {
    next(err);
  }
});