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
  createScheduleSchema,
  updateScheduleSchema,
  deleteScheduleSchema,
  listSchedulesQuerySchema,
  materializeSchema,
  scheduleIdParamSchema,
} from "../schemas/schedules.js";
import {
  listSchedules,
  createScheduleWindow,
  updateScheduleWindow,
  deleteScheduleWindow,
  materializeManually,
} from "../services/schedule.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §11, §8.1 — the schedule template surface, Day 15.
 *
 * One router, five routes:
 *
 * - `GET    /api/v1/schedules?doctorId=…`   list a doctor's windows
 * - `POST   /api/v1/schedules`              create one window
 * - `PATCH  /api/v1/schedules/:id`          edit one window
 * - `DELETE /api/v1/schedules/:id`          remove one window
 * - `POST   /api/v1/schedules/materialize`  re-run the slot generator
 *
 * **Who reaches what (decision 2).** The route gates admit DOCTOR, ADMIN and
 * STAFF; ownership then splits them: ADMIN/STAFF manage any doctor's
 * template, a DOCTOR only their own. For POST the target doctor is the body's
 * `doctorId`, so `requireSelfOrRole` runs here. For PATCH/DELETE the target
 * lives on the row and is not knowable from the URL, so the service does the
 * ownership check — belt and braces, the Day 12 double-enforcement rule.
 * `POST /materialize` is ADMIN/STAFF-only outright: it is a clinic-wide
 * maintenance action with no "own" interpretation a doctor could exercise
 * beyond what a template edit already triggers.
 *
 * `requireAuth` runs router-wide; every route here is authenticated and a
 * future one must inherit the gate.
 */
export const schedulesRouter = Router();

schedulesRouter.use(requireAuth);

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

const selfOrStaff = requireRole($Enums.UserRole.DOCTOR, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

/** The mutation result a client renders: the window plus what generation did. */
function mutationBody(result: { schedule: unknown; materialized: unknown }): Record<string, unknown> {
  return {
    schedule: result.schedule,
    materialized: result.materialized,
  };
}

/* ------------------------------------------------------------------ */
/* §11 — template reads and writes                                      */
/* ------------------------------------------------------------------ */

/**
 * GET — one doctor's weekly template. ADMIN/STAFF read anyone; a DOCTOR reads
 * their own (§4: staff can view doctor schedules; the doctor's dashboard
 * schedule pane reads this same list).
 */
schedulesRouter.get("/", selfOrStaff, async (req, res, next) => {
  try {
    const { doctorId } = listSchedulesQuerySchema.parse(req.query);
    requireSelfOrRole(req, doctorId, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);
    res.status(200).json({ schedules: await listSchedules(doctorId) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST — create one window, then materialise the horizon (the Day 15 DoD:
 * "creating a schedule produces correct slots"). 201. A PATIENT never reaches
 * the ownership check: the role gate above refuses them first.
 */
schedulesRouter.post("/", selfOrStaff, async (req, res, next) => {
  try {
    const parsed = createScheduleSchema.parse(req.body);
    requireSelfOrRole(req, parsed.doctorId, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

    const result = await createScheduleWindow({
      actor: actorOf(req),
      doctorId: parsed.doctorId,
      weekday: parsed.weekday,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      maxPatients: parsed.maxPatients,
      reason: parsed.reason,
      ...requestMeta(req, res),
    });

    res.status(201).json({ message: "Schedule window created.", ...mutationBody(result) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH — edit one window. The doctorId is on the row, so ownership is the
 * service's check; this route's job is the role gate and the schema (reason
 * mandatory, at least one field, no overnight windows).
 */
schedulesRouter.patch("/:id", selfOrStaff, async (req, res, next) => {
  try {
    const { id } = scheduleIdParamSchema.parse(req.params);
    const patch = updateScheduleSchema.parse(req.body);

    const result = await updateScheduleWindow({
      actor: actorOf(req),
      scheduleId: id,
      patch: {
        weekday: patch.weekday,
        startTime: patch.startTime,
        endTime: patch.endTime,
        maxPatients: patch.maxPatients,
      },
      reason: patch.reason,
      ...requestMeta(req, res),
    });

    res.status(200).json({ message: "Schedule window updated.", ...mutationBody(result) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE — remove one window. Reason mandatory (§20: the audit row must say
 * why a bookable thing stopped existing). Existing slots are untouched by
 * §11's rule; the response says so implicitly through the unchanged
 * `materialized` stats — no cascade runs here.
 */
schedulesRouter.delete("/:id", selfOrStaff, async (req, res, next) => {
  try {
    const { id } = scheduleIdParamSchema.parse(req.params);
    const { reason } = deleteScheduleSchema.parse(req.body);

    const result = await deleteScheduleWindow({
      actor: actorOf(req),
      scheduleId: id,
      reason,
      ...requestMeta(req, res),
    });

    res.status(200).json({ message: "Schedule window deleted.", ...mutationBody(result) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /materialize — the manual generator re-run (Day 15's DoD second half:
 * "re-running doesn't duplicate"). ADMIN/STAFF-only, optional `{ doctorId }`
 * to scope to one doctor. The idempotency is the generator's, not this
 * route's: a second run creates nothing because every horizon date already
 * has slots (decision 1).
 */
schedulesRouter.post("/materialize", requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF), async (req, res, next) => {
  try {
    const parsed = materializeSchema.parse(req.body ?? {});
    const stats = await materializeManually(parsed?.doctorId);
    res.status(200).json({ message: "Slot materialisation complete.", materialized: stats });
  } catch (err) {
    next(err);
  }
});
