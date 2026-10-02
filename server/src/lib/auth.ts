import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";

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
