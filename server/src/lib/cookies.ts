import type { CookieOptions, Response } from "express";
import { config } from "../config.js";

/**
 * One definition of the refresh cookie's attributes, shared by /login,
 * /refresh and /logout. Centralised because the three must agree exactly —
 * if /logout cleared a cookie whose path or name differed, the browser would
 * keep the original and the user would stay logged in.
 */

export const REFRESH_COOKIE_NAME = "refresh_token";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const isProduction = config.NODE_ENV === "production";

/**
 * Scoped to the auth mount point on purpose. The refresh token is only ever
 * needed by POST /auth/refresh, so business endpoints should never see it —
 * this keeps it out of their request logs and gives any future endpoint that
 * must not receive a live session token a structural guarantee.
 *
 * sameSite "lax" is correct on localhost because ports are not part of a
 * site: localhost:5173 -> localhost:3000 is cross-origin but same-site, so the
 * cookie still rides along. A split deployment (app.example.com +
 * api.example.com) IS cross-site, and "lax" would silently stop the cookie
 * being sent at all — there it must become "none" with secure, which browsers
 * permit only over HTTPS.
 */
export const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/api/v1/auth",
};

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: SEVEN_DAYS_MS,
  });
}

export function clearRefreshCookie(res: Response): void {
  // No maxAge: clearing only needs the cookie to match on name and path.
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
}

export const REFRESH_TOKEN_EXPIRY_MS = SEVEN_DAYS_MS;
