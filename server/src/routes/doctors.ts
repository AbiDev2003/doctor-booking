import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { config } from "../config.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { requireSelfOrRole } from "../lib/ownership.js";
import { getRequestId } from "../middleware/requestId.js";
import {
  doctorIdParamSchema,
  inviteDoctorSchema,
  inviteStaffSchema,
  updateDoctorSchema,
  reasonSchema,
  optionalReasonSchema,
} from "../schemas/doctors.js";
import {
  inviteDoctor,
  inviteStaff,
  listDoctors,
  getDoctor,
  getTodayQueue,
  updateDoctorProfile,
  verifyDoctor,
  rejectDoctor,
  suspendDoctor,
  unsuspendDoctor,
  archiveDoctor,
  unarchiveDoctor,
} from "../services/doctor.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §5, §5.1, §5.2 — the doctor + staff management surface, Day 12.
 *
 * Two routers live in this file because they are one domain with two
 * prefixes:
 *
 * - `doctorsRouter`  → `/api/v1/doctors` (invite, list, detail, edit, lifecycle)
 * - `staffRouter`    → `/api/v1/staff`   (admin-only staff invitation)
 *
 * **Guards come in layers, and the layers disagree on purpose.** The route
 * gates (`requireRole`) decide who may REACH each endpoint — §5.2's role
 * limits: staff may create/update/suspend/archive doctors but never verify,
 * reject, un-suspend or un-archive, and nobody but staff/admin touches the
 * roster at all. The pure matrix in `lib/doctorState.ts` re-decides the same
 * rules inside the service, because TypeScript cannot see middleware
 * composition and a route wired in the wrong order is exactly the mistake a
 * permission boundary must not depend on. The unit tests in
 * `tests/doctorState.test.ts` pin the matrix; these gates pin the endpoints.
 *
 * `requireAuth` runs router-wide (`doctorsRouter.use`) rather than per-route
 * for the same reason the auth router registers its burst guard once: every
 * route here is authenticated, and a future route added to this file must
 * inherit the gate instead of forgetting it. The one assertion that the
 * composition actually held is `authenticatedUser` below — checked, not `!`.
 */
export const doctorsRouter = Router();
export const staffRouter = Router();

doctorsRouter.use(requireAuth);

/**
 * The `req.user` behind `requireAuth`, or a 401 if a future route wires the
 * middleware in the wrong order (pattern: routes/account.ts).
 */
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

function doctorIdOf(req: Request): string {
  return doctorIdParamSchema.parse(req.params).id;
}

/**
 * §5.2's "STAFF action → admin notification" (D6): a console/log stub today,
 * a real email in Phase 7. Only STAFF-performed actions are summarized — an
 * ADMIN is the authority the summary would be addressed to.
 */
function adminSummaryStub(
  req: Request,
  action: string,
  targetId: string,
): void {
  const user = authenticatedUser(req);
  if (user.role !== $Enums.UserRole.STAFF) return;
  req.log.info(
    { staffId: user.id, action, targetId },
    `§5.2 admin summary (stub): staff ${user.name} performed ${action} on ${targetId}`,
  );
}

/** Every state action carries §20's ip/requestId; assembled once per route. */
function requestMeta(req: Request, res: Response): { ip: string | null; requestId: string } {
  return { ip: getClientIp(req), requestId: getRequestId(res) };
}

/* ------------------------------------------------------------------ */
/* §5.1 — provisioning                                                 */
/* ------------------------------------------------------------------ */

/**
 * Invite a doctor — ADMIN or STAFF (§5.2 lets staff create doctors).
 *
 * 201 + no token in the body: the claim link is logged server-side exactly
 * like Day 7's verification link and Day 11's reset link (Phase 7 sends the
 * real email). Returning the raw token to the INVITER would let anyone who
 * can invite also claim-as, which collapses §5.1's invitation into a
 * password-set endpoint with extra steps.
 */
doctorsRouter.post("/", requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF), async (req, res, next) => {
  try {
    const parsed = inviteDoctorSchema.parse(req.body);
    const actor = actorOf(req);

    const result = await inviteDoctor({
      actor,
      email: parsed.email,
      fullName: parsed.fullName,
      ...requestMeta(req, res),
    });

    const claimUrl = `${config.CLIENT_URL}/claim-account?token=${result.rawToken}`;
    req.log.info({ userId: result.userId }, `Account claim link: ${claimUrl}`);
    adminSummaryStub(req, "DOCTOR_INVITED", result.userId);

    res.status(201).json({ message: "Doctor invited.", userId: result.userId });
  } catch (err) {
    next(err);
  }
});

/** Roster — ADMIN/STAFF. Includes ARCHIVED rows: see `toDoctorDto`. */
doctorsRouter.get("/", requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF), async (_req, res, next) => {
  try {
    res.status(200).json({ doctors: await listDoctors() });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Detail + self-edit (§5.2: doctor reads/edits own descriptive)       */
/* ------------------------------------------------------------------ */

/**
 * ADMIN/STAFF read anyone; a DOCTOR reads themself — the self-or-role split
 * is `requireSelfOrRole` (Day 10), evaluated AFTER the coarse role gate, so
 * a PATIENT never reaches the ownership check at all.
 */
const selfOrStaff = requireRole($Enums.UserRole.DOCTOR, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

doctorsRouter.get("/:id", selfOrStaff, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    requireSelfOrRole(req, id, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);
    res.status(200).json({ doctor: await getDoctor(id) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* §28 — today's queue (Day 14)                                        */
/* ------------------------------------------------------------------ */

/**
 * The doctor's own day-queue. Deliberately two properties, neither of which
 * accepts a path param:
 *
 * - the actor is the doctor themselves — `requireRole(DOCTOR)` plus reading
 *   the id from `req.user.id`, never from the URL, so there is no way to ask
 *   for someone else's queue;
 * - "today" is the clinic's calendar day inside the service
 *   (`getTodayQueue` → `clinicDayRange`), so the route needs no date input to
 *   textually chisel on the caller's behalf.
 *
 * `/me/today` is registered right here among the single-segment reads; it
 * cannot be shadowed by the `/:id` family (those parse one segment), and
 * keeping it before the rising `/:id/:verb` routes in later phases means no
 * future route ever re-anchors "me".
 */
doctorsRouter.get("/me/today", requireRole($Enums.UserRole.DOCTOR), async (req, res, next) => {
  try {
    const queue = await getTodayQueue(authenticatedUser(req).id, config.APP_TIMEZONE);
    res.status(200).json({ queue });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH — descriptive and/or credential fields, never a status field
 * (schemas/doctors.ts). A doctor may edit only their own row and cannot set
 * `consultationFee` (service refuses with 403); ADMIN/STAFF may edit any
 * doctor's descriptive fields, per §5.2. The credential→PENDING move itself
 * is §5.2's rule and lives in the service, not here.
 */
doctorsRouter.patch("/:id", selfOrStaff, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    requireSelfOrRole(req, id, $Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

    const patch = updateDoctorSchema.parse(req.body);
    const result = await updateDoctorProfile({
      actor: actorOf(req),
      doctorId: id,
      patch,
      ...requestMeta(req, res),
    });
    adminSummaryStub(req, "DOCTOR_PROFILE_UPDATED", id);

    res.status(200).json({
      message: "Profile updated.",
      verificationStatus: result.verificationStatus,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* §5.2 — verification decisions (ADMIN-only)                          */
/* ------------------------------------------------------------------ */

/**
 * The four ADMIN-only verbs share their shape with the STAFF-reachable pair
 * below (suspend/archive): same router, opposite `requireRole` list — which
 * is §5.2's role split stated as an import list. The matrix re-checks inside
 * the service regardless of which gate got the request here.
 */
const adminOnly = requireRole($Enums.UserRole.ADMIN);

doctorsRouter.post("/:id/verify", adminOnly, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    await verifyDoctor({ actor: actorOf(req), doctorId: id, ...requestMeta(req, res) });
    res.status(200).json({ message: "Doctor verified.", verificationStatus: "VERIFIED" });
  } catch (err) {
    next(err);
  }
});

doctorsRouter.post("/:id/reject", adminOnly, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    const { reason } = reasonSchema.parse(req.body);
    await rejectDoctor({ actor: actorOf(req), doctorId: id, reason, ...requestMeta(req, res) });
    res.status(200).json({ message: "Doctor rejected.", verificationStatus: "REJECTED" });
  } catch (err) {
    next(err);
  }
});

doctorsRouter.post("/:id/unsuspend", adminOnly, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    const { reason } = optionalReasonSchema.parse(req.body);
    await unsuspendDoctor({ actor: actorOf(req), doctorId: id, reason, ...requestMeta(req, res) });
    res.status(200).json({ message: "Doctor unsuspended." });
  } catch (err) {
    next(err);
  }
});

doctorsRouter.post("/:id/unarchive", adminOnly, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    const { reason } = reasonSchema.parse(req.body);
    await unarchiveDoctor({ actor: actorOf(req), doctorId: id, reason, ...requestMeta(req, res) });
    res.status(200).json({ message: "Doctor unarchived.", verificationStatus: "VERIFIED" });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* §5.2 — STAFF-reachable lifecycle verbs                              */
/* ------------------------------------------------------------------ */

/**
 * Suspend/archive — ADMIN **or** STAFF (§5.2), mandatory reason, sessions
 * revoked in the same transaction (Day 9's DoD through Day 12's routes).
 */
const suspendArchiveGate = requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

doctorsRouter.post("/:id/suspend", suspendArchiveGate, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    const { reason } = reasonSchema.parse(req.body);
    await suspendDoctor({ actor: actorOf(req), doctorId: id, reason, ...requestMeta(req, res) });
    adminSummaryStub(req, "DOCTOR_SUSPENDED", id);
    res.status(200).json({ message: "Doctor suspended." });
  } catch (err) {
    next(err);
  }
});

doctorsRouter.post("/:id/archive", suspendArchiveGate, async (req, res, next) => {
  try {
    const id = doctorIdOf(req);
    const { reason } = reasonSchema.parse(req.body);
    await archiveDoctor({ actor: actorOf(req), doctorId: id, reason, ...requestMeta(req, res) });
    adminSummaryStub(req, "DOCTOR_ARCHIVED", id);
    res.status(200).json({ message: "Doctor archived." });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* §5.1 — staff invitation (admin→staff, ADMIN-only)                   */
/* ------------------------------------------------------------------ */

/**
 * Mounted at `/api/v1/staff`. Inviting a staff member is ADMIN-only even
 * though a STAFF may invite doctors: §5.1's flow is explicitly "admin→staff,
 * admin/staff→doctor" — the difference is that a staff account carries the
 * suspend/archive authority, and who may grant that authority is not the
 * same question as who may grant a merely-bookable doctor account.
 */
staffRouter.use(requireAuth);

staffRouter.post("/", requireRole($Enums.UserRole.ADMIN), async (req, res, next) => {
  try {
    const parsed = inviteStaffSchema.parse(req.body);
    const result = await inviteStaff({
      actor: actorOf(req),
      email: parsed.email,
      fullName: parsed.fullName,
      ...requestMeta(req, res),
    });

    const claimUrl = `${config.CLIENT_URL}/claim-account?token=${result.rawToken}`;
    req.log.info({ userId: result.userId }, `Account claim link: ${claimUrl}`);

    res.status(201).json({ message: "Staff member invited.", userId: result.userId });
  } catch (err) {
    next(err);
  }
});
