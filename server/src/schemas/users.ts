import { z } from "zod";

/**
 * Day 27 admin session-revocation input shapes.
 *
 * The route is deliberately narrow: one user id and an optional reason. It does
 * not accept a "revoke only some sessions" selector because MVP has no session
 * listing (§42), and it does not accept a status flag because revocation is not
 * deactivation — the account keeps working and can sign in again immediately.
 */

/** Path params: a user id is a uuid(7); Prisma would otherwise 500 on a cast. */
export const userIdParamSchema = z.object({
  id: z.uuid("Invalid user id"),
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;

/** The reason is optional, but when supplied it must be a real sentence. */
export const revokeUserSessionsSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Reason must not be blank")
    .max(1000, "Reason must not exceed 1000 characters")
    .optional(),
});

export type RevokeUserSessionsInputShape = z.infer<typeof revokeUserSessionsSchema>;
