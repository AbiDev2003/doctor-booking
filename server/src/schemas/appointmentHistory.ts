import { z } from "zod";

/**
 * The query behind the clinic-wide appointment History surface.
 *
 * Admin History and the staff desk's History both use this exact shape: one
 * optional patient search, equality filters the schema already indexes, and a
 * hard limit. Keeping the schema shared means the two dashboards cannot drift
 * on which filters exist or on how `NEEDS_ATTENTION` is expressed.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD, e.g. 2026-10-09");
const limit = z.coerce.number().int().min(1).max(100).default(50);

export const appointmentHistoryQuerySchema = z.object({
  date: date.optional(),
  from: date.optional(),
  to: date.optional(),
  scope: z.enum(["all", "upcoming", "past", "needsAttention"]).optional(),
  status: z
    .enum(["CONFIRMED", "ARRIVED", "COMPLETED", "CANCELLED", "REJECTED", "NO_SHOW", "PENDING", "NEEDS_ATTENTION"])
    .optional(),
  doctorId: z.uuid("Invalid doctor id").optional(),
  search: z.string().trim().max(100).optional(),
  limit,
});

export type AppointmentHistoryQuery = z.infer<typeof appointmentHistoryQuerySchema>;
