import type { RequestHandler } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";

/**
 * §7's role gate — the second half of "authentication and authorization are
 * separate concepts" (plan.md §6).
 *
 * Mounted AFTER `requireAuth`, which re-reads the account from the database on
 * every request, so the role decided here is the row's current role and never
 * the JWT's `role` claim: a demotion takes effect on the next request, exactly
 * like a suspension (§6.3's per-request re-check). A stale claim must never be
 * the authority on what a session may do.
 *
 * One fixed 403 message for every role decision, for the same reason §6.3's
 * 429s are generic: an endpoint-probing caller must not learn which roles exist
 * or which role it almost had. The `code` stays specific (`FORBIDDEN`) so a
 * legitimate client can react without parsing prose.
 *
 * First callers: Day 12's admin/staff doctor-management routes, Day 14's
 * doctor dashboard, Day 32/33's staff and admin surfaces. Day 10 ships it with
 * unit tests rather than live routes because the only authenticated endpoint
 * that exists today is `/auth/me`, which every role may reach — see the DoD
 * caveat under Day 10 in code-plan.md.
 */
export function requireRole(...roles: readonly $Enums.UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.user?.role;

    // No user means requireAuth did not run ahead of this. 401 rather than 403: the caller is not authenticated, and saying "forbidden" would imply the opposite.
    if (role === undefined) {
      next(new AppError(401, "AUTH_REQUIRED", "Authentication required"));
      return;
    }

    if (!roles.includes(role)) {
      next(new AppError(403, "FORBIDDEN", "You do not have access to this resource"));
      return;
    }

    next();
  };
}
