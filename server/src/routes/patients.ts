import { Router } from "express";
import type { Request } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import { attachPatientEmailSchema, visitHistoryQuerySchema } from "../schemas/staff.js";
import { userIdParamSchema } from "../schemas/users.js";
import { attachProvisionalPatientEmail } from "../services/staff/patientEmail.service.js";
import { getPatientVisitHistory } from "../services/staff/staffDesk.service.js";

/**
 * plan.md §16 — the returning-patient lookup (Day 32).
 *
 *   GET  /api/v1/patients/visit-history?phone=…   ADMIN, STAFF
 *   POST /api/v1/patients/:id/email               ADMIN, STAFF
 *
 * Read-only and phone-keyed. The route's job is the role gate and the query
 * shape; normalization, the metrics and the upcoming rows live in the service.
 * A phone the clinic has never seen answers `found: false` rather than a 404 —
 * "new patient" is a normal desk answer and the UI offers the walk-in form.
 *
 * Day 34 adds the one write the desk needs on a provisional record: attach or
 * correct an email that was omitted at booking. It is not a login path; the
 * service keeps the target provisional and leaves verification to the patient.
 */
export const patientsRouter = Router();

patientsRouter.use(requireAuth);

const staffOnly = requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

function authenticatedUser(req: Request): NonNullable<Request["user"]> {
  if (!req.user) {
    throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  }
  return req.user;
}

patientsRouter.get("/visit-history", staffOnly, async (req, res, next) => {
  try {
    const { phone } = visitHistoryQuerySchema.parse(req.query);
    res.json({ history: await getPatientVisitHistory(phone) });
  } catch (err) {
    next(err);
  }
});

patientsRouter.post("/:id/email", staffOnly, async (req, res, next) => {
  try {
    const { id } = userIdParamSchema.parse(req.params);
    const { email } = attachPatientEmailSchema.parse(req.body);
    const actor = authenticatedUser(req);

    const patient = await attachProvisionalPatientEmail({
      actor: { id: actor.id, role: actor.role, name: actor.name },
      patientId: id,
      email,
      ip: getClientIp(req),
      requestId: getRequestId(res),
    });

    res.status(200).json({ message: "Email attached to the patient record.", patient });
  } catch (err) {
    next(err);
  }
});
