import { randomBytes, randomInt, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { durationToMs } from "./duration.js";

const DEFAULT_BCRYPT_COST = 10;

/**
 * Hash a password using bcryptjs.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, DEFAULT_BCRYPT_COST);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a cryptographically secure random token.
 * @param bytes - Number of random bytes to generate (default 32)
 * @returns Hex-encoded token string
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Hash a token using SHA-256. Stored in AuthToken.tokenHash (hex).
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Token expiry in minutes for email verification.
 * Per plan: stubbed in Phase 7 for real sending; 15 minutes is reasonable.
 */
export const EMAIL_VERIFICATION_TOKEN_EXPIRY_MINUTES = 15;

export function getEmailVerificationExpiry(): Date {
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + EMAIL_VERIFICATION_TOKEN_EXPIRY_MINUTES);
  return expiresAt;
}

/** Width of a §6.2 OTP. Six digits is plan wording ("6-digit OTP" in the
 * Day 11 contract) and matches the brute-force budget documented in
 * rateLimit.service.ts: 20 guesses/min against 10^6 cannot exhaust the space
 * inside any token's lifetime. */
const OTP_DIGITS = 6;

/**
 * A uniformly random 6-digit code, for §6.2's OTP method.
 *
 * `randomInt` is rejection sampling, not `% 1000000` — a modulo over a range
 * that does not divide the PRNG's range evenly would make some codes likelier
 * than others, and the whole security argument for a 6-digit space assumes a
 * uniform draw. `padStart` keeps leading zeros: `randomInt(0, 1e6)` may return
 * `42`, and the code a user received by email was `000042`.
 */
export function generateOtp(): string {
  return randomInt(0, 10 ** OTP_DIGITS).toString().padStart(OTP_DIGITS, "0");
}

/** True when a submitted token LOOKS like a §6.2 OTP rather than a link token. */
export function looksLikeOtp(rawToken: string): boolean {
  return /^\d{6}$/.test(rawToken);
}

/**
 * §6.2's expiry. A LINK lives `PASSWORD_RESET_TTL` (1h); a 6-digit OTP lives
 * `PASSWORD_RESET_OTP_TTL` (60s) because its search space is tiny. Callers that
 * mint a link (including §6.1's email-change token) omit the argument.
 */
export function getPasswordResetExpiry(method: "LINK" | "OTP" = "LINK"): Date {
  return new Date(
    Date.now() + durationToMs(method === "OTP" ? config.PASSWORD_RESET_OTP_TTL : config.PASSWORD_RESET_TTL),
  );
}

/**
 * §5.1's invite-claim expiry — its own knob (`ACCOUNT_CLAIM_TTL`, 1h default).
 * Same `durationToMs` parser as every other duration in this codebase.
 */
export function getAccountClaimExpiry(): Date {
  return new Date(Date.now() + durationToMs(config.ACCOUNT_CLAIM_TTL));
}
