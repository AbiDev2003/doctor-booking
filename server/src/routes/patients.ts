import { Router } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { visitHistoryQuerySchema } from "../schemas/staff.js";
import { getPatientVisitHistory } from "../services/staff/staffDesk.service.js";

/**
 * plan.md §16 — the returning-patient lookup (Day 32).
 *
 *   GET /api/v1/patients/visit-history?phone=…   ADMIN, STAFF
 *
 * Read-only and phone-keyed. The route's job is the role gate and the query
 * shape; normalization, the metrics and the upcoming rows live in the service.
 * A phone the clinic has never seen answers `found: false` rather than a 404 —
 * "new patient" is a normal desk answer and the UI offers the walk-in form.
 */
export const patientsRouter = Router();

patientsRouter.use(requireAuth);

const staffOnly = requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

patientsRouter.get("/visit-history", staffOnly, async (req, res, next) => {
  try {
    const { phone } = visitHistoryQuerySchema.parse(req.query);
    res.json({ history: await getPatientVisitHistory(phone) });
  } catch (err) {
    next(err);
  }
});
