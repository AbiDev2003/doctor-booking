import { $Enums } from "../generated/prisma/client.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import {
  hashPassword,
  comparePassword,
  generateToken,
  hashToken,
  getEmailVerificationExpiry,
} from "../lib/auth.js";
import { normalizePhoneToE164, DEFAULT_COUNTRY_CALLING_CODE } from "../lib/time.js";
import { signAccessToken } from "../lib/jwt.js";
import { REFRESH_TOKEN_EXPIRY_MS } from "../lib/cookies.js";
import {
  assertLoginAttemptAllowed,
  assertOtpVerifyAllowed,
  recordAttempt,
  recordFailureQuietly,
  UNKNOWN_IP_KEY,
} from "./rateLimit.service.js";

/**
 * Either the root client or an interactive-transaction client. Both expose the
 * same delegates, so helpers that write accept one or the other and stay
 * correct when called from inside $transaction — reaching for the root `prisma`
 * inside a transaction uses a second connection, which is neither atomic nor
 * able to see the transaction's uncommitted rows.
 */
type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * The §6.3 identity key: a trimmed, lowercased email.
 *
 * One function, because this value is an identity and not a string. The lockout
 * counts failures grouped by it, and `User.email` is stored lowercased and unique
 * (§6.4), so any other spelling would put a user's failures under a second key —
 * `A@x.com` and `a@x.com` would each get their own 5-failure allowance, and the
 * lockout would be trivially bypassed by varying the case.
 */
function identityKey(email: string): string {
  return email.trim().toLowerCase();
}

/** plan.md §6.3 — 7 days. Matches REFRESH_TOKEN_EXPIRY_MS in lib/cookies.ts. */
function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);
}

/**
 * A real bcrypt hash of a value nobody can supply, compared against when the
 * email does not exist. Without it, "no such user" returns in ~1ms while a
 * wrong password takes ~100ms of bcrypt work — a timing oracle that leaks
 * which emails are registered even though the message says nothing.
 */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export interface RegisterPatientInput {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  ip?: string | null;
}

export interface EmailVerificationTokenResult {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function createEmailVerificationToken(
  client: DbClient,
  userId: string,
  ip?: string | null,
): Promise<EmailVerificationTokenResult> {
  const rawToken = generateToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = getEmailVerificationExpiry();

  await client.authToken.create({
    data: {
      userId,
      purpose: $Enums.AuthTokenPurpose.EMAIL_VERIFICATION,
      tokenHash,
      expiresAt,
      consumedAt: null,
      ip: ip ?? null,
    },
  });

  return { rawToken, tokenHash, expiresAt };
}

export async function registerPatient(input: RegisterPatientInput): Promise<{ userId: string; rawToken: string }> {
  const email = input.email.toLowerCase().trim();
  const normalizedPhone = normalizePhoneToE164(input.phone, DEFAULT_COUNTRY_CALLING_CODE);

  const existingUserByEmail = await prisma.user.findUnique({
    where: { email },
  });
  if (existingUserByEmail) {
    throw new AppError(409, "EMAIL_ALREADY_EXISTS", "Email already registered");
  }

  const existingProfileByPhone = await prisma.patientProfile.findUnique({
    where: { phone: normalizedPhone },
  });
  if (existingProfileByPhone) {
    throw new AppError(409, "PHONE_ALREADY_EXISTS", "Phone number already registered");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        role: $Enums.UserRole.PATIENT,
        fullName: input.fullName.trim(),
        email,
        passwordHash,
        emailVerifiedAt: null,
        pendingEmail: null,
        isDeactivated: false,
      },
    });

    await tx.patientProfile.create({
      data: {
        userId: user.id,
        phone: normalizedPhone,
        phoneVerified: false,
        isProvisional: false,
      },
    });

    const token = await createEmailVerificationToken(tx, user.id, input.ip ?? null);

    return { userId: user.id, rawToken: token.rawToken };
  });

  return result;
}

export async function verifyEmail(
  token: string,
  ip?: string | null,
): Promise<{ userId: string; email: string | null }> {
  const trimmedToken = token.trim();
  const tokenHash = hashToken(trimmedToken);
  const now = new Date();
  const ipKey = ip ?? UNKNOWN_IP_KEY;

  // §6.3 caps verification tries per OTP, and separately caps guessing per IP —
  // the second term is the one that bounds brute force, since each wrong code would
  // otherwise hash to a fresh per-OTP key. Asserted before the lookup below so a
  // spent budget costs one indexed read rather than a token fetch — and before any
  // row is written, so a locked-out caller cannot extend its own budget by
  // generating more attempts.
  await assertOtpVerifyAllowed(tokenHash, ipKey);

  const attempt = {
    identifierKey: tokenHash,
    ipKey,
    purpose: $Enums.AuthAttemptPurpose.OTP_VERIFY,
  };

  const authToken = await prisma.authToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  // Every rejection records a failed try. The four invalid-token cases are one
  // `INVALID_OR_EXPIRED_TOKEN` for the same reason login has one
  // `INVALID_CREDENTIALS`: distinguishing "no such token" from "already used"
  // tells an attacker which of their guesses was real.
  const rejectInvalidToken = async (): Promise<never> => {
    await recordFailureQuietly(attempt);
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired verification token");
  };

  if (!authToken) {
    return rejectInvalidToken();
  }

  if (authToken.purpose !== $Enums.AuthTokenPurpose.EMAIL_VERIFICATION) {
    return rejectInvalidToken();
  }

  if (authToken.consumedAt !== null) {
    return rejectInvalidToken();
  }

  if (authToken.expiresAt < now) {
    return rejectInvalidToken();
  }

  if (authToken.user.isDeactivated) {
    await recordFailureQuietly(attempt);
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  // The token is single-use, so a success can only ever happen once per token —
  // which is why OTP_VERIFY_LIMIT counts *every* interaction with a token rather
  // than only the failures. The budget is "five looks at this code", and the one
  // legitimate look is one of them.
  await recordAttempt({ ...attempt, succeeded: true });

  await prisma.$transaction(async (tx) => {
    await tx.authToken.update({
      where: { id: authToken.id },
      data: { consumedAt: now },
    });

    if (authToken.user.emailVerifiedAt === null) {
      await tx.user.update({
        where: { id: authToken.userId },
        data: { emailVerifiedAt: now },
      });
    }
  });

  return {
    userId: authToken.userId,
    email: authToken.user.email,
  };
}

/* ------------------------------------------------------------------ */
/* Day 8 — sessions                                                    */
/* ------------------------------------------------------------------ */

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginInput extends SessionMeta {
  email: string;
  password: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  role: string;
  emailVerified: boolean;
}

/**
 * Issues an access token (stateless JWT) and a refresh token (opaque random
 * string, stored only as SHA-256). Takes the client so login can create its
 * session row inside the caller's transaction, and refresh can rotate inside
 * its own.
 */
async function issueSession(
  client: DbClient,
  user: { id: string; role: string; emailVerifiedAt: Date | null },
  meta: SessionMeta,
): Promise<Session> {
  const rawRefreshToken = generateToken(32);

  await client.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawRefreshToken),
      expiresAt: refreshExpiry(),
      revokedAt: null,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  return {
    accessToken: await signAccessToken({ userId: user.id, role: user.role }),
    refreshToken: rawRefreshToken,
    userId: user.id,
    role: user.role,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

/**
 * §6.3 blocks BOOKING until the email is verified, not login. Rejecting here
 * would strand every unverified patient: they cannot register again (409),
 * cannot log in, and no resend endpoint exists yet.
 *
 * The lockout is asserted BEFORE the bcrypt comparison, not after — see
 * `assertLoginAttemptAllowed`. Both outcomes are recorded, because a success is
 * what breaks a run of failures: `auth_attempts` could not implement "consecutive"
 * at all if it only stored failures.
 */
export async function login(input: LoginInput): Promise<Session> {
  const email = identityKey(input.email);
  const ipKey = input.ip ?? UNKNOWN_IP_KEY;
  const attempt = { identifierKey: email, ipKey, purpose: $Enums.AuthAttemptPurpose.LOGIN };

  await assertLoginAttemptAllowed(email, ipKey);

  const user = await prisma.user.findUnique({ where: { email } });

  // Provisioned accounts (seeded admin/staff/doctor) have no passwordHash yet.
  const passwordMatches = user?.passwordHash
    ? await comparePassword(input.password, user.passwordHash)
    : await comparePassword(input.password, DUMMY_HASH).then(() => false);

  // One code for "no such email" and "wrong password" — otherwise /login
  // becomes a way to enumerate registered addresses.
  if (!user || !passwordMatches) {
    await recordFailureQuietly(attempt);
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  if (user.isDeactivated) {
    // Recorded as a failure. A deactivated account is a closed door, and letting
    // an attacker keep hammering it costs the owner nothing but the attempts —
    // while *not* recording it would make deactivation a way to probe an address
    // for free, since the 401 here is indistinguishable from a wrong password.
    await recordFailureQuietly(attempt);
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  await recordAttempt({ ...attempt, succeeded: true });

  return issueSession(prisma, user, input);
}

/**
 * Rotation: the presented token is revoked and a new one issued in the same
 * transaction, so a stolen token is usable at most once (§6.3). A revoked
 * token presented again is how reuse would show up; family detection is out
 * of MVP (schema.prisma:1078), so it simply fails.
 */
export async function rotateRefreshToken(rawToken: string, meta: SessionMeta): Promise<Session> {
  const tokenHash = hashToken(rawToken.trim());

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing || existing.revokedAt !== null || existing.expiresAt < new Date()) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid or expired session");
  }

  if (existing.user.isDeactivated) {
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  return prisma.$transaction(async (tx) => {
    // The conditional write is the lock, not the read above: two refreshes
    // racing on the same token both read revokedAt = null, and only one can
    // flip it. Without this, a token redeemed twice in the same moment mints
    // two live sessions, which is the one case rotation exists to prevent.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (claimed.count !== 1) {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid or expired session");
    }

    return issueSession(tx, existing.user, meta);
  });
}

/** Idempotent: logging out twice, or with a token that never existed, is fine. */
export async function logout(rawToken: string): Promise<void> {
  if (!rawToken) return;

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken.trim()) },
    select: { id: true, revokedAt: true },
  });

  if (!existing || existing.revokedAt !== null) return;

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });
}

/**
 * §6.3: "Revoke every session" is one statement, used inside the same
 * transaction as a suspension, deactivation or password reset.
 *
 * It runs ahead of its first caller (Day 9) because it is what makes those
 * immediate.
 */
export async function revokeAllSessions(client: DbClient, userId: string): Promise<void> {
  await client.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * §5.1 staff offboarding, step 1: deactivation refuses login and revokes every
 * active session **in one transaction**.
 *
 * Atomicity is the requirement, not tidiness. Across two writes there is a window
 * where the account is marked deactivated but a refresh token still mints a fresh
 * access token — the user is logged out and logged back in at the same moment, and
 * a status change that claims to be immediate is not. So the flag and the
 * revocation commit together or not at all.
 *
 * The per-request status re-check in `middleware/auth.ts` is the other half: it
 * rejects the access token the client is *already* holding, which no amount of
 * revoking refresh tokens can reach. Revocation stops renewal; the re-check stops
 * the live session. §5.1 requires both, for exactly that reason.
 *
 * Idempotent, and deliberately so. §5.1 deactivation is terminal — there is no
 * reactivate — so a repeated call is a caller bug rather than a state to guard,
 * and making it succeed keeps an offboarding script from failing halfway through a
 * list of staff. `revokeAllSessions` is a no-op on the second pass.
 *
 * NOT here, and this is the honest limit of Day 9: the mandatory audit row with
 * reason, actor and name snapshot (§5.1 step 3), and the admin-only route that
 * calls this. There is no audit-writing service in the codebase yet and no caller
 * with an actor to attribute, so writing one here would mean inventing both. Day
 * 12's suspend/archive and the admin deactivation endpoint own them, and this
 * function is the transaction they wrap.
 */
export async function deactivateUser(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });

    if (!user) {
      throw new AppError(404, "USER_NOT_FOUND", "User not found");
    }

    await tx.user.update({
      where: { id: userId },
      data: { isDeactivated: true },
    });

    await revokeAllSessions(tx, userId);
  });
}

/**
 * Throws if the user's email is not verified.
 * Used to block booking until verified (§6.3).
 */
export async function ensureEmailVerified(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true, isDeactivated: true },
  });

  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  if (user.isDeactivated) {
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  if (user.emailVerifiedAt === null) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Email not verified");
  }
}
