import { Router } from "express";
import type { Request, Response } from "express";
import { isIP } from "node:net";
import { config } from "../config.js";
import { AppError } from "../lib/appError.js";
import { registerSchema, verifyEmailSchema, loginSchema } from "../schemas/auth.js";
import { registerPatient, verifyEmail, login, rotateRefreshToken, logout } from "../services/auth.service.js";
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  clearRefreshCookie,
} from "../lib/cookies.js";
import { requireAuth } from "../middleware/auth.js";
import { authBurstGuard } from "../middleware/rateLimit.js";

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

/**
 * The client address for the auth_attempts / refresh_tokens `ip` columns.
 *
 * It reads `req.ip`, never `x-forwarded-for` directly: `app.ts` sets
 * `trust proxy`, which is what makes `req.ip` the real client rather than the
 * proxy's address. Reading the header here instead would take whatever the
 * caller sent — and Day 9's per-IP lockout is keyed on exactly this value.
 *
 * The result is validated because those columns are `inet`: an address
 * Postgres cannot parse fails the insert and turns a login into a 500. An
 * unparseable address is not worth failing a request over, so it becomes null.
 */
function getClientIp(req: Request): string | null {
  const raw = req.ip ?? req.socket.remoteAddress;
  if (!raw) return null;

  const candidate = raw.replace(/^\[/, "").replace(/\]$/, "").split("%")[0] ?? "";
  return isIP(candidate) > 0 ? candidate : null;
}

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
