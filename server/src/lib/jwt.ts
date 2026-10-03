import { SignJWT, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { config } from "../config.js";
import { AppError } from "./appError.js";

/**
 * Access tokens are JWTs so that the API can authorise a request without a
 * database round trip. They are short-lived (ACCESS_TOKEN_TTL, 15m) and are
 * NOT stored anywhere server-side — Day 9 adds the per-request status
 * re-check that makes that trade-off safe.
 *
 * The refresh token is deliberately NOT a JWT: it is an opaque random string
 * stored hashed, because it must be revocable. See lib/auth.ts and
 * services/auth.service.ts.
 */

const secret = new TextEncoder().encode(config.JWT_ACCESS_SECRET);

export interface AccessTokenClaims {
  userId: string;
  role: string;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(config.ACCESS_TOKEN_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    return payload;
  } catch {
    // Every failure — bad signature, expired, wrong algorithm, malformed —
    // collapses to one code for the same reason verify-email does: a caller
    // must not be able to tell which of these happened.
    throw new AppError(401, "INVALID_ACCESS_TOKEN", "Invalid or expired access token");
  }
}
