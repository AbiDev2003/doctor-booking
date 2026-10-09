import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import { clinicSettingsPatchSchema } from "../schemas/clinics.js";
import { getClinicSettings, updateClinicSettings } from "../services/clinic.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §3.2 — the clinic settings surface, Day 16 (decision 9).
 *
 * Two routes:
 *
 * - `GET   /api/v1/clinics/settings`   read the tunables (ADMIN/STAFF)
 * - `PATCH /api/v1/clinics/settings`   change 1..6 scheduling tunables (ADMIN)
 *
 * **Scope.** The PATCH admits exactly the six scheduling tunables —
 * `bookingHorizonDays`, `cancelCutoffMinutes`, `holdDurationMinutes`,
 * `minLeadMinutes`, `reminderLeadMinutes`, `maxActiveBookingsPerPatient` —
 * and nothing else (the schema has no fields for `timezone`, `currency`,
 * `name` or `defaultConsultationFee`, so those cannot be smuggled in). A
 * widened horizon re-stocks via the generator after commit (decision 10); the
 * audit row is one `CLINIC_SETTINGS_UPDATED` per request, written in the same
 * transaction as the change (the `writeAudit` contract).
 */
export const clinicsRouter = Router();

clinicsRouter.use(requireAuth);

const readGate = requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);
const writeGate = requireRole($Enums.UserRole.ADMIN);

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

/**
 * GET — read the tunables. ADMIN/STAFF only (decision 9): the public storefront
 * already exposes the same row's display subset at /api/v1/public/clinic, so
 * this surface is the management read, not a free-for-all.
 */
clinicsRouter.get("/settings", readGate, async (_req, res, next) => {
  try {
    res.status(200).json({ settings: await getClinicSettings() });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH — change the scheduling tunables. ADMIN-only (decision 9); reason
 * optional (the audit's before/after snapshot is the record). The service's
 * role re-check is what stops a miswired route from opening this up.
 */
clinicsRouter.patch("/settings", writeGate, async (req, res, next) => {
  try {
    const parsed = clinicSettingsPatchSchema.parse(req.body);
    const settings = await updateClinicSettings({
      actor: actorOf(req),
      patch: {
        bookingHorizonDays: parsed.bookingHorizonDays,
        cancelCutoffMinutes: parsed.cancelCutoffMinutes,
        holdDurationMinutes: parsed.holdDurationMinutes,
        minLeadMinutes: parsed.minLeadMinutes,
        reminderLeadMinutes: parsed.reminderLeadMinutes,
        maxActiveBookingsPerPatient: parsed.maxActiveBookingsPerPatient,
      },
      reason: parsed.reason,
      ...requestMeta(req, res),
    });
    res.status(200).json({ message: "Clinic settings updated.", settings });
  } catch (err) {
    next(err);
  }
});