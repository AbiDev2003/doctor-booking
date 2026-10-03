import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: string; email: string | null };
    }
  }
}

/**
 * Verifies the bearer token's signature and expiry, then loads the user.
 *
 * The user load is redundant on Day 8 — the JWT already carries id and role —
 * and is kept deliberately. §6.3 requires a per-request status re-check so that
 * a suspension or deactivation takes effect on the next request rather than at
 * token expiry; doing it here means Day 9's rule is the code's shape from the
 * start instead of a rewrite. Day 9 adds rate limiting and the "revoke every
 * session" wiring around it.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    }

    const payload = await verifyAccessToken(header.slice("Bearer ".length));
    const userId = payload.sub;
    if (!userId) {
      throw new AppError(401, "INVALID_ACCESS_TOKEN", "Invalid or expired access token");
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, email: true, isDeactivated: true },
    });

    if (!user) {
      throw new AppError(401, "INVALID_ACCESS_TOKEN", "Invalid or expired access token");
    }

    // A valid, unexpired token for a deactivated account must stop working now,
    // not in up to 15 minutes when it would expire on its own.
    if (user.isDeactivated) {
      throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
    }

    req.user = { id: user.id, role: user.role, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}
