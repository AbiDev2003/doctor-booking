import { z } from "zod";

/**
 * Day 34: doctor/staff invitation and self-edit schemas, shared with the client.
 *
 * No field may carry a status. `verificationStatus` and `suspendedAt` are not
 * properties of any input — they move only through the §5 matrix
 * (`lib/doctorState.ts`) and the transactions in `doctor.service.ts`.
 */

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
export type InviteStaffInputShape = z.infer<typeof inviteStaffSchema>;

/**
 * A PATCH of optional fields with "at least one present" — `{}` is a 422, not
 * a silent no-op, so a client bug surfaces at the request instead of as a
 * mysterious `NO_CHANGES` 409 one service later. Fields cannot be cleared to
 * empty (min(1)): nulling a credential is not an edit this MVP models, and
 * the discriminating rule — empty string vs unchanged — is exactly the kind
 * of ambiguity a schema should remove before it reaches a comparison.
 */
export const doctorProfileSchema = z.object({
  fullName,
  qualification: z.string().trim().min(1).max(300),
  licenseNumber: z.string().trim().min(1).max(100),
  experience: z.string().trim().min(1).max(100),
  clinicAssociation: z.string().trim().min(1).max(300),
  specialization: z.string().trim().min(1).max(300),
});

export type DoctorProfileInputShape = z.infer<typeof doctorProfileSchema>;

export const updateDoctorSchema = doctorProfileSchema
  .extend({
    // Paise-free (rupees as whole units here) — the plan's §24 money column is
    // Int paise, so the API speaks paise too: no float ever touches a price.
    consultationFee: z.int().min(0).max(10_000_000),
  })
  .partial()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    { message: "At least one field is required" },
  );

export type UpdateDoctorInputShape = z.infer<typeof updateDoctorSchema>;
