import { Router } from "express";
import type { Request } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { getRequestId } from "../middleware/requestId.js";
import { revokeUserSessionsSchema, userIdParamSchema } from "../schemas/users.js";
import { revokeUserSessions } from "../services/auth.service.js";
import { dispatchNotificationInBackground } from "../services/notification.service.js";
import { allSessionsRevokedEmail } from "../lib/emailTemplates.js";

/**
 * plan.md §6.3/§18 — the ADMIN-only account-security surface, Day 27.
 *
 *   POST /api/v1/users/:id/revoke-sessions
 *
 * This is the missing trigger for the §18 security notice: revoke every live
 * refresh token for one user, audit the action, and queue the notice in the same
 * transaction. It is not deactivation — the account remains usable and may sign
 * in again with its existing password.
 *
 * The action is ADMIN-only because it reaches any account, including another
 * ADMIN's. STAFF already receive doctor suspension/archive, and those flows
 * revoke that doctor's sessions as part of their own state change rather than
 * through this endpoint.
 *
 * The route resolves `req.user` by checking it, not `!`, following the auth and
 * account routers: a future middleware-order mistake must fail loudly.
 */
export const usersRouter = Router();

usersRouter.use(requireAuth);

function authenticatedUser(req: Request): NonNullable<Request["user"]> {
  if (!req.user) {
    throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  }
  return req.user;
}

const adminOnly = requireRole($Enums.UserRole.ADMIN);

usersRouter.post("/:id/revoke-sessions", adminOnly, async (req, res, next) => {
  try {
    const { id } = userIdParamSchema.parse(req.params);
    const { reason } = revokeUserSessionsSchema.parse(req.body ?? {});
    const actor = authenticatedUser(req);

    const result = await revokeUserSessions({
      actor: { id: actor.id, role: actor.role, name: actor.name },
      userId: id,
      reason: reason ?? null,
      ip: getClientIp(req),
      requestId: getRequestId(res),
    });

    if (result.notificationId !== null) {
      dispatchNotificationInBackground(
        result.notificationId,
        allSessionsRevokedEmail({ fullName: result.fullName }),
      );
    }

    res.status(200).json({
      message:
        result.revokedCount > 0
          ? "All sessions revoked."
          : "No active sessions to revoke.",
      revokedCount: result.revokedCount,
    });
  } catch (err) {
    next(err);
  }
});
