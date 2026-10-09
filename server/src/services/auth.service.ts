import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { DbClient } from "../lib/prisma.js";
import { isUniqueConstraintViolation } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import {
  hashPassword,
  comparePassword,
  generateToken,
  looksLikeOtp,
  getEmailVerificationExpiry,
  getPasswordResetExpiry,
  generateOtp,
  hashToken,
} from "../lib/auth.js";
import { normalizePhoneToE164, DEFAULT_COUNTRY_CALLING_CODE } from "../lib/time.js";
import { signAccessToken } from "../lib/jwt.js";
import { REFRESH_TOKEN_EXPIRY_MS } from "../lib/cookies.js";
import {
  assertLoginAttemptAllowed,
  assertOtpSendAllowed,
  assertOtpVerifyAllowed,
  recordAttempt,
  recordFailureQuietly,
  UNKNOWN_IP_KEY,
} from "./rateLimit.service.js";
import { writeAudit } from "./audit.service.js";

// `DbClient` — root or transaction client — is exported from lib/prisma.ts;
// see the note there for why it moved out of this file on Day 11.

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

/* ------------------------------------------------------------------ */
/* Day 11 — password recovery (plan.md §6.2)                           */
/* ------------------------------------------------------------------ */

/** How §6.2's ownership proof travelled: a link, or a 6-digit code. */
export type ResetMethod = "LINK" | "OTP";

export interface ForgotPasswordInput {
  email: string;
  method: ResetMethod;
  ip?: string | null;
}

/**
 * The send outcome. `sent: false` is the ONLY thing the endpoint needs to know
 * to stay silent on — the response body it produces is identical either way
 * (§6.2: responses are generic so existence is never leaked); the split exists
 * so the route does not log a recovery link for an address that has none.
 */
export type ForgotPasswordResult =
  | { readonly sent: false }
  | { readonly sent: true; readonly userId: string; readonly rawToken: string; readonly method: ResetMethod };

/** How many fresh OTP draws a collision regenerates before giving up. See issueResetToken. */
const MAX_OTP_DRAW_ATTEMPTS = 5;

/**
 * Creates the `AuthToken` row for a reset, drawing a fresh raw value until the
 * insert lands — the loop exists for OTPs only, and for one structural reason:
 * `AuthToken.tokenHash` is a GLOBAL unique (schema.prisma), verification is
 * `findUnique(hash(submittedToken))` with no userId to narrow it (the portal
 * receives only the code), and a 6-digit space collides by birthday arithmetic:
 * with a handful of live tokens, two of them drawing the same code is a matter
 * of time, not improbability. The second send must therefore receive a
 * different code — regenerate, rather than weaken the unique index or invent a
 * lookup key the endpoint contract does not carry. A LINK token's 32-byte
 * space makes the same event impossible in practice, so a P2002 there means
 * something other than chance and is rethrown instead of retried.
 *
 * Called OUTSIDE any surrounding transaction deliberately: Postgres aborts a
 * transaction on the first statement error, so a caught P2002 would leave a
 * dead transaction with nothing to retry into (a savepoint would fix that and
 * buy nothing — see forgotPassword for why the two writes are ordered rather
 * than atomic).
 */
async function issueResetToken(
  client: DbClient,
  userId: string,
  method: ResetMethod,
  ip: string | null,
): Promise<string> {
  let lastError: unknown;

  for (let draw = 0; draw < MAX_OTP_DRAW_ATTEMPTS; draw++) {
    const rawToken = method === "OTP" ? generateOtp() : generateToken(32);

    try {
      await client.authToken.create({
        data: {
          userId,
          purpose: $Enums.AuthTokenPurpose.PASSWORD_RESET,
          tokenHash: hashToken(rawToken),
          expiresAt: getPasswordResetExpiry(),
          consumedAt: null,
          ip,
        },
      });
      return rawToken;
    } catch (err) {
      lastError = err;
      if (!isUniqueConstraintViolation(err) || method !== "OTP") throw err;
    }
  }

  // Unreachable in practice: five draws all colliding with live tokens is a
  // ~10^-27 event at realistic concurrency. Surfacing the real error beats
  // inventing a friendly message for a condition nobody can act on.
  throw lastError;
}

/**
 * §6.2 request: issue a reset link or OTP — and reveal nothing.
 *
 * The generic response is produced by the ROUTE (one body for both branches);
 * what this function returns is what the route may safely log. The ordering
 * below is the security argument in full:
 *
 * 1. **Cap first, record always.** `assertOtpSendAllowed` runs before any
 *    write, so a locked address cannot extend its own budget by re-requesting
 *    (same ordering as `verifyEmail`). The accepted request is then recorded
 *    whether or not the address exists — recording only real sends would turn
 *    the 429 itself into an existence oracle: registered addresses would start
 *    refusing after three requests while unregistered ones never would.
 * 2. **Unknown == deactivated == silent skip.** A seeded/provisioned account
 *    (`passwordHash: null`) is a normal target here — this is the §5.1 claim
 *    flow (plan.md:355) — but a deactivated one gets the same silence as a
 *    typo, because sending a recovery door to a closed account tells whoever
 *    holds the inbox something the endpoint must never confirm.
 * 3. **Resend invalidates.** Outstanding tokens for this purpose are consumed
 *    before the replacement is issued, so at most one live token exists per
 *    account (§6.2). The two writes are ordered rather than transactional
 *    because `issueResetToken` retries on a unique collision, and a retry
 *    cannot run inside a Postgres transaction the collision just aborted; the
 *    failure mode of the gap — consume lands, issue fails — is "no token
 *    exists", which the user resolves by requesting again.
 */
export async function forgotPassword(input: ForgotPasswordInput): Promise<ForgotPasswordResult> {
  const email = identityKey(input.email);
  const ipKey = input.ip ?? UNKNOWN_IP_KEY;

  await assertOtpSendAllowed(email, ipKey);

  await recordAttempt({
    identifierKey: email,
    ipKey,
    purpose: $Enums.AuthAttemptPurpose.OTP_SEND,
    succeeded: true,
  });

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.isDeactivated) {
    return { sent: false };
  }

  await prisma.authToken.updateMany({
    where: { userId: user.id, purpose: $Enums.AuthTokenPurpose.PASSWORD_RESET, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const rawToken = await issueResetToken(prisma, user.id, input.method, input.ip ?? null);

  return { sent: true, userId: user.id, rawToken, method: input.method };
}

export interface ResetPasswordInput {
  token: string;
  password: string;
  ip?: string | null;
  requestId?: string | null;
}

/**
 * §6.2 completion: consume the token, set the new password, log every session
 * out, audit the reset — one transaction, so none of the four can happen
 * without the others.
 *
 * Mirrors `verifyEmail`'s verification shape on purpose: per-token budget
 * asserted before the lookup, one `INVALID_OR_EXPIRED_TOKEN` for every way a
 * token can be wrong (distinguishing "no such token" from "already used" tells
 * an attacker which of their guesses was real), every interaction recorded.
 *
 * The method in the audit row is inferred from the submitted token's SHAPE
 * (§6.2 audits "method used"): the portal carries only the token, so neither
 * the row nor the request can say which way it arrived — but `/^\d{6}$/` is
 * exactly the choice the user made, and a 64-hex link token can never match it.
 *
 * A `passwordHash: null` account (seeded admin/staff/doctor) is a first-class
 * target: this is the §5.1 claim path, audited like any other reset — the
 * owner claims bootstrap through this same flow rather than a temporary
 * password (plan.md:355).
 */
export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const submittedToken = input.token.trim();
  const tokenHash = hashToken(submittedToken);
  const ipKey = input.ip ?? UNKNOWN_IP_KEY;

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

  // Every invalid case records a failed try and returns the same error — see
  // verifyEmail for the full reasoning.
  const rejectInvalidToken = async (): Promise<never> => {
    await recordFailureQuietly(attempt);
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired reset token");
  };

  if (!authToken) {
    return rejectInvalidToken();
  }

  if (authToken.purpose !== $Enums.AuthTokenPurpose.PASSWORD_RESET) {
    return rejectInvalidToken();
  }

  if (authToken.consumedAt !== null) {
    return rejectInvalidToken();
  }

  if (authToken.expiresAt < new Date()) {
    return rejectInvalidToken();
  }

  if (authToken.user.isDeactivated) {
    await recordFailureQuietly(attempt);
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  // A success breaks the failure run for this key (readIdentityRun cuts on the
  // most recent success), and the five-try budget counts every interaction —
  // including the one legitimate submission.
  await recordAttempt({ ...attempt, succeeded: true });

  // bcrypt BEFORE the transaction: ~100ms of hashing must not hold a database connection open. The hash is a pure value by the time the write begins.
  const passwordHash = await hashPassword(input.password);
  const now = new Date();
  const method: ResetMethod = looksLikeOtp(submittedToken) ? "OTP" : "LINK";

  await prisma.$transaction(async (tx) => {
    // The conditional claim IS the single-use lock, not the read above: two
    // racing submits both read `consumedAt = null`, and only one can flip it.
    // Same pattern as rotateRefreshToken's claimed update (Day 8).
    const claimed = await tx.authToken.updateMany({
      where: { id: authToken.id, consumedAt: null },
      data: { consumedAt: now },
    });

    if (claimed.count !== 1) {
      throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired reset token");
    }

    // Sweep every other outstanding reset token for this account: a resend
    // issued a second code, and §6.2 makes a successful reset the end of all of
    // them — the loser of the claim above must not still be live.
    await tx.authToken.updateMany({
      where: { userId: authToken.userId, purpose: $Enums.AuthTokenPurpose.PASSWORD_RESET, consumedAt: null },
      data: { consumedAt: now },
    });

    await tx.user.update({
      where: { id: authToken.userId },
      data: { passwordHash },
    });

    // §6.3: "forces re-login everywhere". Revoking the refresh tokens stops the
    // session renewing; middleware/auth.ts's per-request re-check stops the
    // access token the client already holds.
    await revokeAllSessions(tx, authToken.userId);

    // §6.2: audited with actor, method and timestamp — inside the same
    // transaction as the reset itself, so the change and its audit row commit
    // together (audit.service.ts). `before` is deliberately absent: there is no
    // honest snapshot of a password, and a hash is not something an audit row
    // should carry around.
    await writeAudit(tx, {
      action: "PASSWORD_RESET",
      targetType: "user",
      targetId: authToken.userId,
      actor: {
        id: authToken.user.id,
        role: authToken.user.role,
        name: authToken.user.fullName,
      },
      after: { method },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Day 12 — §5.1 account claim (the invitation's second half)          */
/* ------------------------------------------------------------------ */

export interface ClaimAccountInput {
  token: string;
  password: string;
  ip?: string | null;
  requestId?: string | null;
}

/**
 * §5.1's claim — the moment an invited DOCTOR/STAFF/ADMIN sets their first
 * password. This is the whole reason `User.passwordHash` is nullable: the
 * account exists (`null` hash = provisioned, not claimed) and this is the one
 * path that turns it into a real credential. §5.1 forbids handing anyone a
 * temporary password, so the invitation token IS the credential proof.
 *
 * Deliberately the same shape as `resetPassword` above — same caps, same
 * generic single-use rejection, same conditional claim as the concurrency
 * lock — because it is literally the same mechanic with a different
 * `purpose`. Differences, each with a reason:
 *
 * - **TTL is `ACCOUNT_CLAIM_TTL` (24h), not `PASSWORD_RESET_TTL` (15m):**
 *   a reset is an emergency, an invitation is not (config.ts).
 * - **`emailVerifiedAt` is set on claim (Day 12 decision D4):** the link was
 *   delivered to this address, so opening it is proof of the address — §6.3
 *   does not REQUIRE verification for provisioned roles, so this gates
 *   nothing; it simply stops the flag from being a lie.
 * - **Sessions are NOT revoked:** with a null `passwordHash` this account
 *   could never log in (login compares against a null hash and fails), so
 *   there is no session to revoke. A second claim racing the first is settled
 *   by the conditional token claim, not by revocation.
 * - **No `DoctorHistory` row:** claiming is an auth event on a `User`, not a
 *   doctor-lifecycle event. The `AuditLog` row below is the record; the
 *   `INVITED` history row was written when the invitation created the
 *   profile.
 *
 * The DoctorProfile's `verificationStatus` deliberately does not move here:
 * `INVITED` means "has not submitted profile details yet" (§5), and a
 * password says nothing about credentials. Status moves on the §5.2
 * credential edit.
 */
export async function claimAccount(input: ClaimAccountInput): Promise<{ userId: string }> {
  const submittedToken = input.token.trim();
  const tokenHash = hashToken(submittedToken);
  const ipKey = input.ip ?? UNKNOWN_IP_KEY;

  // The same per-token and per-IP budgets as every other token verification
  // (§6.3): five looks total, twenty a minute from one host. The claim token is a 32-byte link — guessing it is hopeless — but the caps cost nothing and one code path cannot drift from the others.
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

  // One refusal for every way a token can be wrong: distinguishing "no such
  // token" from "already claimed" would tell a prober which of their guesses
  // was real. Same doctrine as verifyEmail and resetPassword.
  const rejectInvalidToken = async (): Promise<never> => {
    await recordFailureQuietly(attempt);
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired invitation token");
  };

  if (!authToken) {
    return rejectInvalidToken();
  }
  if (authToken.purpose !== $Enums.AuthTokenPurpose.ACCOUNT_CLAIM) {
    return rejectInvalidToken();
  }
  if (authToken.consumedAt !== null) {
    return rejectInvalidToken();
  }
  if (authToken.expiresAt < new Date()) {
    return rejectInvalidToken();
  }
  if (authToken.user.isDeactivated) {
    await recordFailureQuietly(attempt);
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  await recordAttempt({ ...attempt, succeeded: true });

  // bcrypt BEFORE the transaction — ~100ms must not hold a connection open.
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // The conditional claim IS the single-use lock: two racing submits both
    // read `consumedAt = null`, only one flips it.
    const claimed = await tx.authToken.updateMany({
      where: { id: authToken.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) {
      throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired invitation token");
    }

    // A resend issues a fresh token; claiming with one must not leave any
    // earlier invitation still live — the same sweep resetPassword does for
    // PASSWORD_RESET, scoped to this purpose.
    await tx.authToken.updateMany({
      where: {
        userId: authToken.userId,
        purpose: $Enums.AuthTokenPurpose.ACCOUNT_CLAIM,
        consumedAt: null,
      },
      data: { consumedAt: now },
    });

    await tx.user.update({
      where: { id: authToken.userId },
      data: { passwordHash, emailVerifiedAt: now },
    });

    await writeAudit(tx, {
      action: "ACCOUNT_CLAIMED",
      targetType: "user",
      targetId: authToken.userId,
      actor: {
        id: authToken.user.id,
        role: authToken.user.role,
        name: authToken.user.fullName,
      },
      after: { passwordSet: true, emailVerified: true },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });

  return { userId: authToken.userId };
}
