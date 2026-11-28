import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { getClientIp } from "../lib/clientIp.js";
import { getRequestId } from "../middleware/requestId.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  adminDoctorCredentialRequestsQuerySchema,
  doctorCredentialRequestIdParamSchema,
  optionalReasonSchema,
  reasonSchema,
} from "../schemas/doctors.js";
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
import { listOutstandingPayments } from "../services/payments/outstandingPayments.service.js";
import { outstandingPaymentsQuerySchema } from "../schemas/payments.js";
import {
  approveDoctorCredentialChangeRequest,
  listDoctorCredentialChangeRequests,
  rejectDoctorCredentialChangeRequest,
} from "../services/doctors/doctor.service.js";
import {
  approveScheduleChangeRequest,
  listDoctorScheduleChangeRequests,
  rejectScheduleChangeRequest,
} from "../services/schedules/scheduleChangeRequest.service.js";
import {
  adminDoctorScheduleRequestsQuerySchema,
  doctorScheduleRequestIdParamSchema,
} from "../schemas/scheduleChangeRequests.js";
import type { ActorContext } from "../services/doctors/doctor.service.js";

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
 * ADMIN-only. The dashboard's other mutations live where they always did
 * (`/doctors`, `/slots`, `/appointments`, `/payments`, `/clinics`), each with
 * its own role gate and service-level re-enforcement. Doctor-proposed credential
 * changes are reviewed here because the queue is an admin-only decision. Keeping
 * the whole surface under `/admin` makes the one mount STAFF must never reach
 * visible as a single boundary.
 */
export const adminRouter = Router();

adminRouter.use(requireAuth);

const adminOnly = requireRole($Enums.UserRole.ADMIN);

function actorOf(req: Request): ActorContext {
  if (!req.user) {
    throw new Error("adminRouter is mounted behind requireAuth");
  }
  return { id: req.user.id, role: req.user.role, name: req.user.name };
}

function requestMeta(req: Request, res: Response): { ip: string | null; requestId: string } {
  return { ip: getClientIp(req), requestId: getRequestId(res) };
}

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
    const virtualStatus = query.status === "NEEDS_ATTENTION";
    res.json(
      await listAdminAppointments({
        date: query.date,
        from: query.from,
        to: query.to,
        scope: query.scope ?? (virtualStatus ? "needsAttention" : undefined),
        status: virtualStatus ? undefined : (query.status as $Enums.AppointmentStatus | undefined),
        doctorId: query.doctorId,
        search: query.search,
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

/** Outstanding receivables — the same read the desk uses, admin view-only. */
adminRouter.get("/outstanding", adminOnly, async (req, res, next) => {
  try {
    const query = outstandingPaymentsQuerySchema.parse(req.query);
    res.json(await listOutstandingPayments({ limit: query.limit }));
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

/* -------------------------------------------------------------------------- */
/* Doctor-proposed credential changes — admin-only approval                   */
/* -------------------------------------------------------------------------- */

adminRouter.get("/doctor-credential-requests", adminOnly, async (req, res, next) => {
  try {
    const query = adminDoctorCredentialRequestsQuerySchema.parse(req.query);
    res.json(
      await listDoctorCredentialChangeRequests({
        status: query.status as $Enums.DoctorCredentialChangeStatus,
        limit: query.limit,
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/doctor-credential-requests/:id/approve", adminOnly, async (req, res, next) => {
  try {
    const { id } = doctorCredentialRequestIdParamSchema.parse(req.params);
    const body = optionalReasonSchema.parse(req.body ?? {});
    res.json(
      await approveDoctorCredentialChangeRequest({
        actor: actorOf(req),
        credentialRequestId: id,
        ...(body.reason !== undefined && { reviewNote: body.reason }),
        ...requestMeta(req, res),
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/doctor-credential-requests/:id/reject", adminOnly, async (req, res, next) => {
  try {
    const { id } = doctorCredentialRequestIdParamSchema.parse(req.params);
    const { reason } = reasonSchema.parse(req.body);
    res.json(
      await rejectDoctorCredentialChangeRequest({
        actor: actorOf(req),
        credentialRequestId: id,
        reviewNote: reason,
        ...requestMeta(req, res),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* Doctor-proposed schedule/time-off changes — admin-only approval             */
/* -------------------------------------------------------------------------- */

adminRouter.get("/doctor-schedule-requests", adminOnly, async (req, res, next) => {
  try {
    const query = adminDoctorScheduleRequestsQuerySchema.parse(req.query);
    res.json(
      await listDoctorScheduleChangeRequests({
        status: query.status as $Enums.DoctorScheduleChangeStatus,
        doctorId: query.doctorId,
        limit: query.limit,
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/doctor-schedule-requests/:id/approve", adminOnly, async (req, res, next) => {
  try {
    const { id } = doctorScheduleRequestIdParamSchema.parse(req.params);
    const body = optionalReasonSchema.parse(req.body ?? {});
    res.json(
      await approveScheduleChangeRequest({
        actor: actorOf(req),
        scheduleRequestId: id,
        ...(body.reason !== undefined && { reviewNote: body.reason }),
        ...requestMeta(req, res),
      }),
    );
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/doctor-schedule-requests/:id/reject", adminOnly, async (req, res, next) => {
  try {
    const { id } = doctorScheduleRequestIdParamSchema.parse(req.params);
    const { reason } = reasonSchema.parse(req.body);
    res.json(
      await rejectScheduleChangeRequest({
        actor: actorOf(req),
        scheduleRequestId: id,
        reviewNote: reason,
        ...requestMeta(req, res),
      }),
    );
  } catch (err) {
    next(err);
  }
});
