import type { NextFunction, Request, Response } from "express";
import { $Enums } from "../generated/prisma/client.js";
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
 * Verifies the bearer token, then re-reads the account (§6.3's per-request status
 * re-check).
 *
 * The database read is what makes a suspension, archive or deactivation take
 * effect on the *next request* rather than at token expiry — plan.md:490 is
 * explicit that a 15-minute TTL alone is not sufficient. It costs one indexed
 * primary-key lookup, and it is the reason `revokeAllSessions` is instant: revoking
 * the refresh tokens stops the session being renewed, and this check stops the
 * access token already in the client's memory.
 *
 * The role is also taken from the database rather than from the JWT's `role` claim.
 * The claim is what lets a request skip the lookup in principle; reading the role
 * from the row instead means a demotion takes effect immediately too, and it costs
 * nothing extra given the row is being fetched anyway. A stale claim must never be
 * the authority on what a session may do.
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
      select: {
        id: true,
        role: true,
        email: true,
        isDeactivated: true,
        // `doctorProfile` is null for every non-doctor, which is what keeps this
        // one query serving all four roles — there is no second lookup, and no
        // `StaffProfile` to look up (code-plan.md:208: STAFF is a `User.role` value
        // with no attributes of its own, so `isDeactivated` is the whole of it).
        doctorProfile: { select: { suspendedAt: true, verificationStatus: true } },
      },
    });

    if (!user) {
      throw new AppError(401, "INVALID_ACCESS_TOKEN", "Invalid or expired access token");
    }

    // Checked before the doctor states below, so a deactivated doctor is told the
    // account is deactivated rather than suspended. §5.1 deactivation is terminal
    // in MVP and says nothing about suspension, so it is the more specific truth.
    if (user.isDeactivated) {
      throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
    }

    // §5.2: suspension and archive must both disable the doctor's login, and both
    // are orthogonal to verification status — `suspendedAt` is a nullable pair of
    // columns precisely so un-suspending restores the lifecycle value the doctor
    // already held. A separate `SUSPENDED` enum value could not express that.
    if (user.doctorProfile?.suspendedAt != null) {
      throw new AppError(403, "ACCOUNT_SUSPENDED", "Account is suspended");
    }

    // ARCHIVED is terminal off-boarding: "Archived doctors cannot log in, every
    // active session is revoked" (§5.2). Un-archive is admin-only and moves the
    // doctor to VERIFIED, which is Day 12's transition to own.
    if (user.doctorProfile?.verificationStatus === $Enums.DoctorVerificationStatus.ARCHIVED) {
      throw new AppError(403, "ACCOUNT_ARCHIVED", "Account is archived");
    }

    // NOT checked here: `verificationStatus` of INVITED, PENDING_VERIFICATION or
    // REJECTED. §5.2 says a doctor awaiting re-verification "keeps every existing
    // appointment untouched" and is only hidden from *new* bookings — so gating the
    // whole API on verification would lock a doctor out of the dashboard they need
    // in order to complete it. §6.3 gates booking, not login, and the booking-side
    // check is Phase 4's. The §5 transition matrix itself is Day 12's; this is
    // deliberately only the two states §5.2 says disable login.
    req.user = { id: user.id, role: user.role, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}
