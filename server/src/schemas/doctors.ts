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

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address");

const fullName = z
  .string()
  .trim()
  .min(1, "Full name is required")
  .max(200, "Full name must not exceed 200 characters");

export const inviteDoctorSchema = z.object({ email, fullName });
export const inviteStaffSchema = z.object({ email, fullName });

export type InviteDoctorInputShape = z.infer<typeof inviteDoctorSchema>;

/**
 * §5.1's claim body (`claimAccountSchema`) lives in schemas/auth.ts beside
 * resetPasswordSchema — same token mechanic, same password policy, one place
 * to keep them identical. Only the invitation ITSELF (invite doctor/staff)
 * belongs to this file.
 */

/**
 * A PATCH of optional fields with "at least one present" — `{}` is a 422, not
 * a silent no-op, so a client bug surfaces at the request instead of as a
 * mysterious `NO_CHANGES` 409 one service later. Fields cannot be cleared to
 * empty (min(1)): nulling a credential is not an edit this MVP models, and
 * the discriminating rule — empty string vs unchanged — is exactly the kind
 * of ambiguity a schema should remove before it reaches a comparison.
 */
export const updateDoctorSchema = z
  .object({
    fullName: fullName.optional(),
    qualification: z.string().trim().min(1).max(300).optional(),
    licenseNumber: z.string().trim().min(1).max(100).optional(),
    experience: z.string().trim().min(1).max(100).optional(),
    clinicAssociation: z.string().trim().min(1).max(300).optional(),
    specialization: z.string().trim().min(1).max(300).optional(),
    // Paise-free (rupees as whole units here) — the plan's §24 money column is
    // Int paise, so the API speaks paise too: no float ever touches a price.
    consultationFee: z.int().min(0).max(10_000_000).optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    { message: "At least one field is required" },
  );

export type UpdateDoctorInputShape = z.infer<typeof updateDoctorSchema>;

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
