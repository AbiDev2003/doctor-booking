import { z } from "zod";

/**
 * Day 16 request shapes — the clinic settings surface (§3.2, decision 9).
 *
 * Scope is deliberately the SIX scheduling tunables, nothing else: `timezone`
 * (relocating a clinic is not a settings edit — it would invalidate every
 * stored `startAt`), `currency`, `name` and `defaultConsultationFee` are all
 * excluded (payments-phase §24). Everything that IS admitted is a number the
 * schema bounds sanely; the service re-checks the merged row before writing.
 */

const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(1000, "Reason must not exceed 1000 characters");

/** The six scheduling tunables, exactly the set decision 9 admits. */
export const clinicSettingsPatchSchema = z
  .object({
    bookingHorizonDays: z.int().min(1, "must be at least 1").max(365, "must not exceed 365"),
    cancelCutoffMinutes: z.int().min(0, "must not be negative").max(1440, "must not exceed one day"),
    holdDurationMinutes: z.int().min(1, "must be at least 1").max(1440, "must not exceed one day"),
    minLeadMinutes: z.int().min(0, "must not be negative").max(1440, "must not exceed one day"),
    reminderLeadMinutes: z.int().min(0, "must not be negative").max(1440, "must not exceed one day"),
    maxActiveBookingsPerPatient: z.int().min(1, "must be at least 1").max(100, "must not exceed 100"),
    reason: reason.optional(),
  })
  .refine((patch) => Object.entries(patch).some(([key, value]) => key !== "reason" && value !== undefined), {
    message: "At least one field is required",
  });

export type ClinicSettingsPatchShape = z.infer<typeof clinicSettingsPatchSchema>;