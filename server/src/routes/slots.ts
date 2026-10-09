import { Router } from "express";
import type { Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import {
  createSlotSchema,
  updateSlotSchema,
  slotDisableSchema,
  slotEnableSchema,
  listSlotsQuerySchema,
  slotIdParamSchema,
} from "../schemas/slots.js";
import {
  createSlot,
  listSlots,
  setSlotDisabled,
  updateSlot,
} from "../services/slot.service.js";
import type { ActorContext } from "../services/doctor.service.js";

/**
 * plan.md §8.4, §8.2 — the dated-Slot management surface, Day 16.
 *
 * Five routes:
 *
 * - `GET   /api/v1/slots?doctorId=…&slotDate=…`   management list
 * - `POST  /api/v1/slots`                         one manual slot (201)
 * - `PATCH /api/v1/slots/:id`                     capacity-only or time/date edit
 * - `POST  /api/v1/slots/:id/disable`             audited availability split
 * - `POST  /api/v1/slots/:id/enable`              audited re-enable
 *
 * **Roles (decision 1).** ADMIN and STAFF only — a DOCTOR's availability tool
 * is Day 18's `DoctorUnavailability`, never slot mutation, so unlike the
 * schedules router there is no `requireSelfOrRole` owner split: every STAFF
 * member may manage any doctor's slots (§4). The gate admits exactly the two
 * roles, and the SPVL service re-enforces them (Day 12's double-enforcement).
 *
 * No hard DELETE (decision 7): disable is the removal semantics, audited with
 * a mandatory reason. Bulk-week create (`POST /slots/bulk`) is deferred.
 */
export const slotsRouter = Router();

slotsRouter.use(requireAuth);

const slotsActorOnly = requireRole($Enums.UserRole.ADMIN, $Enums.UserRole.STAFF);

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
/* §8.4 — reads and writes                                             */
/* ------------------------------------------------------------------ */

/**
 * GET — the staff management list, scoped to one doctor (and one clinic-local
 * day when asked). All slots, disabled included, so the screen can show WHY an
 * edit is refused and offer the audit trail.
 */
slotsRouter.get("/", slotsActorOnly, async (req, res, next) => {
  try {
    const { doctorId, slotDate } = listSlotsQuerySchema.parse(req.query);
    res.status(200).json({ slots: await listSlots(doctorId, slotDate) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST — one manual slot. Reason optional (decision 2); the horizon and
 * overlap checks live in the service. 201. A PATIENT or DOCTOR never reaches
 * this handler: the role gate refuses them first.
 */
slotsRouter.post("/", slotsActorOnly, async (req, res, next) => {
  try {
    const parsed = createSlotSchema.parse(req.body);
    const slot = await createSlot({
      actor: actorOf(req),
      doctorId: parsed.doctorId,
      slotDate: parsed.slotDate,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      maxPatients: parsed.maxPatients,
      reason: parsed.reason,
      ...requestMeta(req, res),
    });
    res.status(201).json({ message: "Slot created.", slot });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH — the §8.4 edit. One verb for capacity-only (maxPatients) and time/date
 * edits; the service branches on which fields arrived, applies the seat-or-hold
 * guard to time edits only (decision 3), and audits SLOT_UPDATED vs
 * SLOT_CAPACITY_CHANGE accordingly. Reason mandatory (schema; 422 when missing).
 */
slotsRouter.patch("/:id", slotsActorOnly, async (req, res, next) => {
  try {
    const { id } = slotIdParamSchema.parse(req.params);
    const parsed = updateSlotSchema.parse(req.body);

    const slot = await updateSlot({
      actor: actorOf(req),
      slotId: id,
      patch: {
        slotDate: parsed.slotDate,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        maxPatients: parsed.maxPatients,
      },
      reason: parsed.reason,
      ...requestMeta(req, res),
    });

    res.status(200).json({ message: "Slot updated.", slot });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/disable — the audited availability split (decision 7). Blocked by
 * the same seat-or-hold guard as a time edit (409 SLOT_HELD) while any
 * patient's booking depends on the slot; reason is mandatory (§8.4).
 */
slotsRouter.post("/:id/disable", slotsActorOnly, async (req, res, next) => {
  try {
    const { id } = slotIdParamSchema.parse(req.params);
    const { reason } = slotDisableSchema.parse(req.body);

    const slot = await setSlotDisabled({
      actor: actorOf(req),
      slotId: id,
      reason,
      enabled: false,
      ...requestMeta(req, res),
    });

    res.status(200).json({ message: "Slot disabled.", slot });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/enable — bring an availability split back, again audited and with
 * a mandatory reason. Always allowed: re-enabling breaks nobody's booking.
 */
slotsRouter.post("/:id/enable", slotsActorOnly, async (req, res, next) => {
  try {
    const { id } = slotIdParamSchema.parse(req.params);
    const { reason } = slotEnableSchema.parse(req.body);

    const slot = await setSlotDisabled({
      actor: actorOf(req),
      slotId: id,
      reason,
      enabled: true,
      ...requestMeta(req, res),
    });

    res.status(200).json({ message: "Slot enabled.", slot });
  } catch (err) {
    next(err);
  }
});