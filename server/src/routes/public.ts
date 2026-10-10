import { Router } from "express";
import { publicAvailabilityQuerySchema, publicDoctorIdParamSchema } from "../schemas/public.js";
import {
  getPublicClinic,
  getPublicDoctor,
  listPublicDoctors,
} from "../services/public.service.js";
import { listDoctorAvailability } from "../services/availability.service.js";

/**
 * plan.md §26 — the public website's API surface, Day 13.
 *
 * The deliberate contrast with the rest of the app: this router mounts NO
 * authentication middleware, and nothing on it performs a write. It is the
 * storefront window — everything here is visible to an anonymous visitor, and
 * that is the rule: if a field must stay private, it is absent from the
 * service's DTO (`services/public.service.ts`), never filtered out of a
 * broader response at render time.
 *
 * Read-only by construction: there is no verb on this router, so there is no
 * way to mistake public access for public writes.
 */
export const publicRouter = Router();

publicRouter.get("/clinic", async (_req, res, next) => {
  try {
    res.status(200).json(await getPublicClinic());
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/doctors", async (_req, res, next) => {
  try {
    res.status(200).json({ doctors: await listPublicDoctors() });
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/doctors/:id", async (req, res, next) => {
  try {
    const { id } = publicDoctorIdParamSchema.parse(req.params);
    res.status(200).json({ doctor: await getPublicDoctor(id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Day 17 — the storefront's read-only slot list for one doctor-day. Anonymous,
 * like the rest of this router; it performs no write and exposes no patient
 * data. A doctor who is not bookable answers 404 (via `assertBookableDoctor`),
 * and a date outside the horizon answers `{ availability: [] }` — see
 * `services/availability.service.ts`.
 */
publicRouter.get("/doctors/:id/availability", async (req, res, next) => {
  try {
    const { id } = publicDoctorIdParamSchema.parse(req.params);
    const { date } = publicAvailabilityQuerySchema.parse(req.query);
    res.status(200).json({ availability: await listDoctorAvailability(id, date) });
  } catch (err) {
    next(err);
  }
});