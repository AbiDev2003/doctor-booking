import { z } from "zod";

/** Public path params: an id is a uuid(7); Prisma would otherwise 500 on a cast. */
export const publicDoctorIdParamSchema = z.object({
  id: z.uuid("Invalid doctor id"),
});

export type PublicDoctorIdParam = z.infer<typeof publicDoctorIdParamSchema>;

/**
 * True when a `YYYY-MM-DD` string names a real calendar day. The regex alone
 * would accept `2026-02-30`, which `Date.UTC` silently rolls forward to March
 * 2nd — a request that intended one day must not be answered for another.
 */
function isRealCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * GET /public/doctors/:id/availability?date=YYYY-MM-DD — the clinic-local day
 * to list. `date` is REQUIRED (locked decision 2): a single explicit day keeps
 * the read cheap and its horizon bounds check unambiguous. The `refine` turns a
 * malformed or impossible date into a 422 at the boundary, before any
 * conversion could roll it over.
 */
export const publicAvailabilityQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD, e.g. 2026-10-09")
    .refine(isRealCalendarDate, "must be a real calendar date"),
});

export type PublicAvailabilityQuery = z.infer<typeof publicAvailabilityQuerySchema>;