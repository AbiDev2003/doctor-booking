import type { Request } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "./appError.js";

/**
 * §7's ownership gate: "a logged-in patient requesting /appointments/:id is not
 * automatically allowed to see that appointment" — the resource's owner must be
 * the caller, or the caller must hold a role the plan allows onto that
 * resource (staff and admin work across patients; a patient never does).
 *
 * Exported and unused on purpose, following the same rule as
 * `assertOtpSendAllowed` (`rateLimit.service.ts`): the first routes that need
 * it — Day 13's appointment list, Day 14's doctor schedule, Day 30's patient
 * dashboard — do not exist yet, and a helper written against imagined call
 * sites is how the real ones end up with a near-copy instead. The judgment
 * (self, or which roles) is split from the lookup so it stays one screen.
 *
 * A refusal is 403, not 404. The plan's §7 example describes an authorization
 * failure, and every id in this system is an unguessable uuid(7), so "you may
 * not touch this" leaks nothing an attacker could not already enumerate —
 * while a 404 would tell the legitimate owner their resource is missing.
 */
export function requireSelfOrRole(
  req: Request,
  ownerId: string,
  ...allowedRoles: readonly $Enums.UserRole[]
): void {
  const user = req.user;

  // Reached only if a route forgot requireAuth ahead of this. Same reasoning as requireRole: unauthenticated is 401, not 403.
  if (!user) {
    throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  }

  if (user.id === ownerId || allowedRoles.includes(user.role)) {
    return;
  }

  throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
}
