import { Router } from "express";
import type { Request } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { config } from "../config.js";
import { AppError } from "../lib/appError.js";
import { getClientIp } from "../lib/clientIp.js";
import { clearRefreshCookie } from "../lib/cookies.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { authBurstGuard } from "../middleware/rateLimit.js";
import { getRequestId } from "../middleware/requestId.js";
import { verifyEmailSchema } from "../schemas/auth.js";
import { changeEmailSchema, changePhoneSchema, deleteAccountSchema } from "../schemas/account.js";
import { changeEmail, verifyEmailChange, changePhone, deleteAccount } from "../services/account.service.js";

/**
 * plan.md §6.1 — patient account management. Mounted at `/api/v1/auth` beside
 * the auth router (app.ts), so the paths read `/auth/change-email` etc.: these
 * are identity endpoints sharing the §6.3 guard, the lockout-backed password
 * checks and the OTP caps with login, not a separate resource family.
 */
export const accountRouter = Router();

/**
 * §6.3's coarse outer guard, same as the auth router's — and for the same
 * reasons (see routes/auth.ts): these routes do bcrypt re-authentication and
 * send verification mail, which is exactly the work the guard exists to shed
 * before it happens. The DB-backed caps in rateLimit.service.ts remain the
 * real policy; this is the cheap filter ahead of them.
 */
accountRouter.use(authBurstGuard);

/**
 * The `req.user` behind `requireAuth` + `requireRole`, or a 401 if a future
 * route wires the middleware up in the wrong order.
 *
 * TypeScript cannot see middleware composition — `req.user` stays optional in
 * the global Express type on purpose (a route WITHOUT requireAuth must still
 * compile). This is the one place that asserts the invariant, and it asserts
 * it by checking, not by `!`, so the wrong order fails loudly instead of
 * dereferencing undefined somewhere downstream.
 */
function authenticatedUser(req: Request): NonNullable<Request["user"]> {
  if (!req.user) {
    throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  }
  return req.user;
}

/**
 * §6.1: every mutation below is PATIENT-scoped — the plan puts this surface on
 * the patient dashboard (§6.1), while staff/doctor identity management is not
 * part of MVP. `verify-email-change` is deliberately NOT behind the gate: like
 * Day 7's email verification, the link is opened from an inbox, possibly on a
 * device where nobody is signed in, and the token itself is the authorization.
 */
const patientOnly = requireRole($Enums.UserRole.PATIENT);

accountRouter.post("/change-email", requireAuth, patientOnly, async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const parsed = changeEmailSchema.parse(req.body);

    const { rawToken } = await changeEmail({
      userId: user.id,
      email: parsed.email,
      ip: getClientIp(req),
      requestId: getRequestId(res),
    });

    // Phase 7's email is a console stub, exactly like Day 7's verification
    // link: it goes to the server log only. The client's response carries no
    // token — the new address must receive it, or the flow proves nothing.
    const verifyUrl = `${config.CLIENT_URL}/verify-email-change?token=${rawToken}`;
    req.log.info({ userId: user.id }, `Email change verification link: ${verifyUrl}`);

    res.status(200).json({ message: "Verification link sent to the new email address." });
  } catch (err) {
    next(err);
  }
});

accountRouter.post("/verify-email-change", async (req, res, next) => {
  try {
    const parsed = verifyEmailSchema.parse(req.body);
    await verifyEmailChange(parsed.token, { ip: getClientIp(req), requestId: getRequestId(res) });
    res.status(200).json({ message: "Email address updated." });
  } catch (err) {
    next(err);
  }
});

accountRouter.post("/change-phone", requireAuth, patientOnly, async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const parsed = changePhoneSchema.parse(req.body);

    await changePhone({
      userId: user.id,
      phone: parsed.phone,
      password: parsed.password,
      ip: getClientIp(req),
      requestId: getRequestId(res),
    });

    res.status(200).json({ message: "Phone number updated." });
  } catch (err) {
    next(err);
  }
});

accountRouter.post("/delete-account", requireAuth, patientOnly, async (req, res, next) => {
  try {
    const user = authenticatedUser(req);
    const parsed = deleteAccountSchema.parse(req.body);

    await deleteAccount({
      userId: user.id,
      password: parsed.password,
      ip: getClientIp(req),
      requestId: getRequestId(res),
    });

    // The server revoked every refresh token in the same transaction as the
    // deletion; clearing the cookie is the client's half — the browser must
    // not keep presenting a token we would refuse to honour.
    clearRefreshCookie(res);
    res.status(200).json({ message: "Account deleted." });
  } catch (err) {
    next(err);
  }
});
