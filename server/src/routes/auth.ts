import { Router } from "express";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { AppError } from "../lib/appError.js";
import { registerSchema, verifyEmailSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, claimAccountSchema } from "../schemas/auth.js";
import {
  registerPatient,
  verifyEmail,
  login,
  rotateRefreshToken,
  logout,
  forgotPassword,
  resetPassword,
  claimAccount,
} from "../services/auth.service.js";
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  clearRefreshCookie,
} from "../lib/cookies.js";
import { getClientIp } from "../lib/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { authBurstGuard } from "../middleware/rateLimit.js";
import { getRequestId } from "../middleware/requestId.js";

export const authRouter = Router();

/**
 * §6.3's coarse outer guard, on every route in this router — including the
 * unauthenticated Day 7 ones, which is the point of an outer layer: it sheds load
 * before the expensive work, namely the DB-backed caps in `rateLimit.service.ts`
 * and the bcrypt comparison behind `/login`.
 *
 * **It does not shed body parsing.** `app.use(express.json())` is registered at
 * `app.ts:39`, ahead of this router at `app.ts:45`, so bodies are already parsed by
 * the time this runs. That is accepted rather than fixed by hoisting the guard into
 * `app.ts`: `express.json` is capped at 1mb, so parsing a shed request costs
 * milliseconds of arithmetic, while the database round trip and bcrypt cost ~100ms —
 * and keeping the guard inside the auth router means it covers the routes Day 11
 * adds without anyone having to remember a second registration. If auth bodies ever
 * grow past the 1mb cap, revisit the ordering then.
 *
 * Strictly looser than the real policy (100/min against the DB cap's 20/min) so it
 * is never the reason a legitimate request is refused. `auth_attempts.ipKey`
 * remains the IP authority.
 */
authRouter.use(authBurstGuard);

authRouter.post("/register", async (req, res, next) => {
  try {
    const parsed = registerSchema.parse(req.body);
    const ip = getClientIp(req);

    const result = await registerPatient({
      email: parsed.email,
      password: parsed.password,
      fullName: parsed.fullName,
      phone: parsed.phone,
      ip,
    });

    const verificationUrl = `${config.CLIENT_URL}/verify-email?token=${result.rawToken}`;
    req.log.info({ userId: result.userId }, `Email verification link: ${verificationUrl}`);

    res.status(201).json({
      message: "Registration successful. Please verify your email.",
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/verify-email", async (req, res, next) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const parsed = verifyEmailSchema.parse({ token });
    await verifyEmail(parsed.token, getClientIp(req));
    res.status(200).json({ message: "Email verified successfully" });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/verify-email", async (req, res, next) => {
  try {
    const parsed = verifyEmailSchema.parse(req.body);
    await verifyEmail(parsed.token, getClientIp(req));
    res.status(200).json({ message: "Email verified successfully" });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Day 8 — sessions                                                    */
/* ------------------------------------------------------------------ */

function sessionMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const userAgent = req.headers["user-agent"];
  return {
    ip: getClientIp(req),
    userAgent: typeof userAgent === "string" ? userAgent : null,
  };
}

authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const session = await login({ ...parsed, ...sessionMeta(req) });

    setRefreshCookie(res, session.refreshToken);

    // The refresh token travels ONLY in the httpOnly cookie. The access token goes in the body for the client to hold in memory.
    res.status(200).json({
      accessToken: session.accessToken,
      userId: session.userId,
      role: session.role,
      emailVerified: session.emailVerified,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid or expired session");
    }

    const session = await rotateRefreshToken(raw, sessionMeta(req));
    setRefreshCookie(res, session.refreshToken);

    res.status(200).json({
      accessToken: session.accessToken,
      userId: session.userId,
      role: session.role,
      emailVerified: session.emailVerified,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof raw === "string" && raw.length > 0) {
      await logout(raw);
    }
    // Clear the cookie even if the token was already invalid — the browser must
    // not be left holding one we would refuse to honour.
    clearRefreshCookie(res);
    res.status(200).json({ message: "Logged out" });
  } catch (err) {
    next(err);
  }
});

/** Day 8 DoD: "access API". Day 10 turns this into the ownership baseline. */
authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  res.status(200).json({ user: req.user });
});

/* ------------------------------------------------------------------ */
/* Day 11 — password recovery (§6.2)                                    */
/* ------------------------------------------------------------------ */

/**
 * §6.2 request, for every role — no `requireAuth`, obviously, but also no role
 * gate: a locked-out admin resets the same way a patient does.
 *
 * The response body is written HERE and is byte-identical whether or not an
 * account exists: `forgotPassword` reports `sent` only so this route knows
 * whether there is anything to log. The dev-mode link/OTP line below is the
 * Phase 7 email stub, same as Day 7's verification link — it goes to the
 * server log, never to the client, because the response must not distinguish
 * the branches it just refused to distinguish in its body either.
 */
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const parsed = forgotPasswordSchema.parse(req.body);
    const ip = getClientIp(req);

    const result = await forgotPassword({
      email: parsed.email,
      method: parsed.method === "otp" ? "OTP" : "LINK",
      ip,
    });

    if (result.sent) {
      if (result.method === "LINK") {
        const resetUrl = `${config.CLIENT_URL}/reset-password?token=${result.rawToken}`;
        req.log.info({ userId: result.userId }, `Password reset link: ${resetUrl}`);
      } else {
        req.log.info({ userId: result.userId }, `Password reset OTP: ${result.rawToken}`);
      }
    }

    res.status(200).json({
      message: "If an account exists for that email, a recovery message has been sent.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * §6.2 completion — link token or OTP, one endpoint, because they are one
 * AuthToken mechanic. Wrong token on this route costs one of the token's five
 * verification tries (rateLimit.service.ts), and `retryAfterSeconds` arrives
 * via the error handler for the 429 case.
 */
authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const parsed = resetPasswordSchema.parse(req.body);

    await resetPassword({
      token: parsed.token,
      password: parsed.password,
      ip: getClientIp(req),
      requestId: getRequestId(res),
    });

    // The client clears any stored session state on this response: the reset
    // revoked every refresh token server-side, and a client still holding an
    // access token would look signed-in against a session that no longer
    // renews until its 15-minute TTL lapses.
    res.status(200).json({ message: "Password has been reset. You can now sign in." });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Day 12 — §5.1 account claim (the invitation's second half)          */
/* ------------------------------------------------------------------ */

/**
 * The invitation link's landing endpoint — unauthenticated for the same
 * reason `/reset-password` is: the link is opened from an inbox, possibly on
 * a device where nobody is signed in, and the token itself is the
 * authorization (D1: its own `ACCOUNT_CLAIM` purpose and `ACCOUNT_CLAIM_TTL`,
 * deliberately not the 15-minute reset's — an invitation may sit unread for
 * hours, and a token that expires faster than people read email becomes a
 * support loop).
 *
 * Response is generic on a bad token (400 `INVALID_OR_EXPIRED_TOKEN` from the
 * service, like reset), and success reports only "claimed": no session is
 * issued here — the account's `INVITED` status may still gate what happens
 * next, and Day 9's login remains the single place sessions are minted. The
 * client routes to sign-in on 200 (client/src/pages/ClaimAccount.tsx).
 */
authRouter.post("/claim-account", async (req, res, next) => {
  try {
    const parsed = claimAccountSchema.parse(req.body);

    await claimAccount({
      token: parsed.token,
      password: parsed.password,
      ip: getClientIp(req),
      requestId: getRequestId(res),
    });

    res.status(200).json({ message: "Account claimed. You can now sign in." });
  } catch (err) {
    next(err);
  }
});
