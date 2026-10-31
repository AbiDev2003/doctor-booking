import { Router } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  adminAppointmentsQuerySchema,
  adminNotificationsQuerySchema,
  adminPatientsQuerySchema,
  adminPaymentsQuerySchema,
  adminRefundsQuerySchema,
} from "../schemas/admin.js";
import {
  getAdminOverview,
  listAdminAppointments,
  listAdminNotifications,
  listAdminPatients,
  listAdminPayments,
  listAdminRefunds,
} from "../services/admin/adminRead.service.js";

/**
 * plan.md §29/§31 — the admin dashboard's read surface, Day 33.
 *
 *   GET /api/v1/admin/overview       today's counts, money and failure queues
 *   GET /api/v1/admin/patients       patient roster + search
 *   GET /api/v1/admin/appointments   appointments with date/status/doctor filters
 *   GET /api/v1/admin/payments       every payment with its refunds
 *   GET /api/v1/admin/refunds        gateway refunds awaiting retry/review
 *   GET /api/v1/admin/notifications  delivery feed, failures visible
 *
 * ADMIN-only, read-only. The mutations the dashboard drives live where they
 * always did (`/doctors`, `/slots`, `/appointments`, `/payments`, `/clinics`),
 * each with its own role gate and service-level re-enforcement. Keeping the new
 * read endpoints under `/admin` makes the one surface STAFF must never reach
 * visible as a single mount.
 */
export const adminRouter = Router();

adminRouter.use(requireAuth);

const adminOnly = requireRole($Enums.UserRole.ADMIN);

adminRouter.get("/overview", adminOnly, async (_req, res, next) => {
  try {
    res.json({ overview: await getAdminOverview() });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/patients", adminOnly, async (req, res, next) => {
  try {
    const query = adminPatientsQuerySchema.parse(req.query);
    res.json(await listAdminPatients({ search: query.search, limit: query.limit }));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/appointments", adminOnly, async (req, res, next) => {
  try {
    const query = adminAppointmentsQuerySchema.parse(req.query);
    res.json(
      await listAdminAppointments({
        date: query.date,
        status: query.status as $Enums.AppointmentStatus | undefined,
        doctorId: query.doctorId,
        limit: query.limit,
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/payments", adminOnly, async (req, res, next) => {
  try {
    const query = adminPaymentsQuerySchema.parse(req.query);
    res.json(
      await listAdminPayments({
        status: query.status as $Enums.PaymentStatus | undefined,
        method: query.method as $Enums.PaymentMethod | undefined,
        limit: query.limit,
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/refunds", adminOnly, async (req, res, next) => {
  try {
    const query = adminRefundsQuerySchema.parse(req.query);
    res.json(await listAdminRefunds({ status: query.status as $Enums.RefundStatus, limit: query.limit }));
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/notifications", adminOnly, async (req, res, next) => {
  try {
    const query = adminNotificationsQuerySchema.parse(req.query);
    res.json(
      await listAdminNotifications({
        status: query.status as $Enums.NotificationStatus | undefined,
        type: query.type,
        limit: query.limit,
      }),
    );
  } catch (err) {
    next(err);
  }
});
