import { z } from "zod";

/**
 * Day 12 request shapes. Two rules run through every schema here:
 *
 * - **No field may carry a status.** `verificationStatus` and `suspendedAt`
 *   are not properties of any input — they move only through the §5 matrix
 *   (lib/doctorState.ts) and the transactions in doctor.service.ts. A schema
 *   that accepted them would be the client deciding server rules (§3.4).
 * - **Mandatory reasons where §5.2/§8.4 demand them** (reject, suspend,
 *   archive, unarchive), `.min(1)` on the server because a frontend
 *   requirement is a UX nicety, not enforcement.
 */

/** Path params: an id is a uuid(7); Prisma would otherwise 500 on a cast. */
export const doctorIdParamSchema = z.object({
  id: z.uuid("Invalid doctor id"),
});

export type DoctorIdParam = z.infer<typeof doctorIdParamSchema>;

/**
 * Day 34: invitations and doctor self-edits now live in
 * `shared/validation/doctors.ts` so the client validates with the same objects.
 */
export * from "../shared/validation/doctors.js";

/** The §5.2/§8.4 mandatory reason, shaped once. */
const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(1000, "Reason must not exceed 1000 characters");

export const reasonSchema = z.object({ reason });
export type ReasonInputShape = z.infer<typeof reasonSchema>;

/** Unsuspend is audited but §5.2 does not make its reason mandatory — optional here. */
export const optionalReasonSchema = z.object({ reason: reason.optional() });
export type OptionalReasonInputShape = z.infer<typeof optionalReasonSchema>;
