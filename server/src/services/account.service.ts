import { $Enums } from "../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { comparePassword, generateToken, hashToken, getPasswordResetExpiry } from "../lib/auth.js";
import { normalizePhoneToE164, DEFAULT_COUNTRY_CALLING_CODE } from "../lib/time.js";
import {
  assertLoginAttemptAllowed,
  assertOtpSendAllowed,
  assertOtpVerifyAllowed,
  recordAttempt,
  recordFailureQuietly,
  UNKNOWN_IP_KEY,
} from "./rateLimit.service.js";
import { writeAudit } from "./audit.service.js";
import { revokeAllSessions } from "./auth.service.js";

/**
 * plan.md §6.1 — patient identity management: email change (verified by a link
 * to the NEW address), phone change (session + re-auth), and account deletion
 * (re-auth, then one transaction of release → void → guard → anonymise).
 *
 * Every flow here writes its audit row INSIDE the same transaction as the
 * change (audit.service.ts): a `pendingEmail` with no request row, a released
 * hold with no release row, or an anonymised patient with no before/after
 * snapshot are all partial states §6.1 and §20 forbid. The actor block is the
 * patient's own — they are acting on their own account — and its name is
 * captured from the row BEFORE any anonymisation, which is the whole point of
 * a snapshot (§5.1: attribution survives the actor being changed away).
 */

/** What every route here contributes to its audit rows: the §20 ip + request id. */
export interface RequestMeta {
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/**
 * §6.3 re-authentication for an ALREADY authenticated caller (§6.1's phone
 * change and delete both require it; the locked Day 11 decision is
 * **current password only** — no OTP alternative, because the OTP path would
 * re-send to the very address whose ownership the step is meant to
 * re-confirm, proving nothing extra).
 *
 * The check **participates in the same identity lockout as login**: same
 * `AuthAttemptPurpose.LOGIN`, same identity key, failures recorded, success
 * recorded. Without that this endpoint would be a side door around §6.3 — an
 * attacker holding a stolen session could grind the current password here at
 * burst-guard speed while `/login` sits locked out, and the lockout's whole
 * claim ("5 failures lock the identity") would quietly exclude the one surface
 * where the password is asked for after the session exists.
 *
 * A `passwordHash: null` account (a provisioned seed row that somehow holds a
 * session) fails without bcrypt rather than against a dummy: the caller is
 * already authenticated *as that account*, so "does this account have a
 * password" is not a secret from it, and there is no unauthenticated timing
 * channel to protect — comparePassword's DUMMY_HASH exists for exactly the
 * channel this is not.
 */
async function assertCurrentPasswordMatches(
  user: { id: string; email: string | null; passwordHash: string | null },
  password: string,
  ipKey: string,
): Promise<void> {
  // The email is §6.3's identity key. A session-holding patient always has one
  // (registration requires it), so the id fallback is a "count the attempt
  // anyway" branch rather than a live path — and skipping the record instead
  // would hand such an account unlimited guesses.
  const identifierKey = (user.email ?? user.id).trim().toLowerCase();
  const attempt = { identifierKey, ipKey, purpose: $Enums.AuthAttemptPurpose.LOGIN };

  await assertLoginAttemptAllowed(identifierKey, ipKey);

  const matches = user.passwordHash !== null && (await comparePassword(password, user.passwordHash));

  if (!matches) {
    await recordFailureQuietly(attempt);
    throw new AppError(403, "PASSWORD_INCORRECT", "Current password is incorrect");
  }

  await recordAttempt({ ...attempt, succeeded: true });
}

/* ------------------------------------------------------------------ */
/* §6.1 — email change (verified by link to the new address)           */
/* ------------------------------------------------------------------ */

export interface ChangeEmailInput extends RequestMeta {
  readonly userId: string;
  readonly email: string;
}

/**
 * Holds the new address in `pendingEmail` and mails a verification link to it
 * — the OLD address stays active until the link is opened (§6.1: "no
 * half-changed identity"), so nothing about the account changes for an
 * attacker who controls an inbox the user no longer has.
 *
 * Ordering mirrors forgotPassword: cap the sends TO the new address first
 * (email-bombing someone else's inbox through this endpoint is exactly what
 * `assertOtpSendAllowed` exists for), record the accepted request whether or
 * not it lands, then write. Uniqueness is checked INSIDE the transaction
 * against both `email` and `pendingEmail` — `pendingEmail` has no unique index
 * (schema.prisma), so this check plus the authoritative re-check at accept
 * time are what stop two accounts from parking the same address.
 *
 * No re-authentication step: §6.1 assigns the password factor to phone and
 * delete, and this change cannot activate itself — the link goes to the new
 * address and the old one keeps working until it is opened.
 */
export async function changeEmail(input: ChangeEmailInput): Promise<{ rawToken: string }> {
  const email = input.email.trim().toLowerCase();
  const ipKey = input.ip ?? UNKNOWN_IP_KEY;

  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  if (user.email === email) {
    throw new AppError(409, "EMAIL_UNCHANGED", "This is already your email address");
  }

  await assertOtpSendAllowed(email, ipKey);
  await recordAttempt({
    identifierKey: email,
    ipKey,
    purpose: $Enums.AuthAttemptPurpose.OTP_SEND,
    succeeded: true,
  });

  const rawToken = await prisma.$transaction(async (tx) => {
    const taken = await tx.user.findFirst({
      where: {
        id: { not: user.id },
        OR: [{ email }, { pendingEmail: email }],
      },
      select: { id: true },
    });

    if (taken) {
      // §6.1: "a duplicate is rejected with a clear message" — an authenticated
      // self-service endpoint may say the address is taken; the generic-response
      // rule belongs to unauthenticated surfaces where existence is a secret.
      throw new AppError(409, "EMAIL_ALREADY_EXISTS", "Email address is already in use");
    }

    // Resend invalidates: the same single-use rule as §6.2's reset tokens.
    await tx.authToken.updateMany({
      where: { userId: user.id, purpose: $Enums.AuthTokenPurpose.EMAIL_CHANGE, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await tx.user.update({
      where: { id: user.id },
      data: { pendingEmail: email },
    });

    const issuedToken = generateToken(32);
    await tx.authToken.create({
      data: {
        userId: user.id,
        purpose: $Enums.AuthTokenPurpose.EMAIL_CHANGE,
        tokenHash: hashToken(issuedToken),
        expiresAt: getPasswordResetExpiry(),
        consumedAt: null,
        ip: input.ip ?? null,
      },
    });

    // The request is itself a write to an identity field, so it is audited too:
    // §6.1's "every change is audited" should be able to show a pendingEmail
    // that was requested and never verified, not only the ones that landed.
    await writeAudit(tx, {
      action: "EMAIL_CHANGE_REQUESTED",
      targetType: "user",
      targetId: user.id,
      actor: { id: user.id, role: user.role, name: user.fullName },
      before: { email: user.email },
      after: { pendingEmail: email },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return issuedToken;
  });

  return { rawToken };
}

/**
 * Accepts the emailed link: `pendingEmail` becomes `email`, the token is
 * consumed, and the address is marked verified — opening a link delivered to
 * the new address IS proof of that address, which is exactly what
 * `emailVerifiedAt` means (the address currently on file was proven). The old
 * address's flag is not carried over; it is discarded with the old address.
 *
 * The uniqueness check runs inside the transaction (§6.1: "re-checked before
 * accept") because `pendingEmail` has no unique index: two accounts can park
 * the same address and both pass the request-time check, and the race between
 * that check and this accept is real. `User.email`'s unique index is the
 * serialization point that makes the last window safe — a concurrent claim
 * surfaces as P2002 and is mapped to the same clear 409.
 *
 * Unauthenticated on purpose, like Day 7's `/verify-email`: the link may be
 * opened on a device where nobody is signed in, and the token itself is the
 * authorization.
 */
export async function verifyEmailChange(token: string, meta: RequestMeta): Promise<void> {
  const submittedToken = token.trim();
  const tokenHash = hashToken(submittedToken);
  const ipKey = meta.ip ?? UNKNOWN_IP_KEY;

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

  const rejectInvalidToken = async (): Promise<never> => {
    await recordFailureQuietly(attempt);
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired verification token");
  };

  if (!authToken) {
    return rejectInvalidToken();
  }

  if (authToken.purpose !== $Enums.AuthTokenPurpose.EMAIL_CHANGE) {
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

  // The request path writes token and pendingEmail in one transaction, so a
  // live token with no pending address cannot arise — but a token must never
  // activate `null`, and "cannot arise" is exactly when a defensive branch is
  // cheapest to get wrong.
  const newEmail = authToken.user.pendingEmail;
  if (newEmail === null) {
    return rejectInvalidToken();
  }

  await recordAttempt({ ...attempt, succeeded: true });

  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      // Single-use under concurrency: the conditional claim is the lock (the
      // same pattern as resetPassword and rotateRefreshToken).
      const claimed = await tx.authToken.updateMany({
        where: { id: authToken.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) {
        throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired verification token");
      }

      const taken = await tx.user.findFirst({
        where: {
          id: { not: authToken.userId },
          OR: [{ email: newEmail }, { pendingEmail: newEmail }],
        },
        select: { id: true },
      });
      if (taken) {
        throw new AppError(409, "EMAIL_ALREADY_EXISTS", "Email address is already in use");
      }

      await tx.user.update({
        where: { id: authToken.userId },
        data: { email: newEmail, pendingEmail: null, emailVerifiedAt: now },
      });

      await writeAudit(tx, {
        action: "EMAIL_CHANGED",
        targetType: "user",
        targetId: authToken.userId,
        actor: {
          id: authToken.user.id,
          role: authToken.user.role,
          name: authToken.user.fullName,
        },
        before: { email: authToken.user.email },
        after: { email: newEmail },
        ip: meta.ip ?? null,
        requestId: meta.requestId ?? null,
      });
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      throw new AppError(409, "EMAIL_ALREADY_EXISTS", "Email address is already in use");
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* §6.1 — phone change (session + password re-auth)                    */
/* ------------------------------------------------------------------ */

export interface ChangePhoneInput extends RequestMeta {
  readonly userId: string;
  readonly phone: string;
  readonly password: string;
}

/**
 * §6.1's phone rule, in full: authorized by the **authenticated,
 * email-verified session plus a password re-authentication**, normalized to
 * E.164, stored with `phoneVerified = false` (there is no SMS channel to prove
 * the new number with — §6.1 forbids inventing one), uniqueness-checked
 * before the write, audited with old and new value.
 *
 * The change applies immediately — unlike email — because what was proven is
 * the session, not the number (§6.1).
 */
export async function changePhone(input: ChangePhoneInput): Promise<void> {
  const ipKey = input.ip ?? UNKNOWN_IP_KEY;

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { patientProfile: true },
  });

  if (!user || !user.patientProfile) {
    // A PATIENT without a profile row is unreachable through any write path
    // (registerPatient creates both in one transaction), so this is a data
    // answer rather than a malformed request — 404, never a 500: there is
    // nothing server-side to fix and nothing client-side to correct.
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  if (user.emailVerifiedAt === null) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email before changing your phone number");
  }

  await assertCurrentPasswordMatches(user, input.password, ipKey);

  const normalizedPhone = normalizePhoneToE164(input.phone, DEFAULT_COUNTRY_CALLING_CODE);

  if (normalizedPhone === user.patientProfile.phone) {
    throw new AppError(409, "PHONE_UNCHANGED", "This is already your phone number");
  }

  const existing = await prisma.patientProfile.findUnique({
    where: { phone: normalizedPhone },
    select: { userId: true },
  });
  if (existing) {
    throw new AppError(409, "PHONE_ALREADY_EXISTS", "Phone number already registered");
  }

  const oldPhone = user.patientProfile.phone;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.patientProfile.update({
        where: { userId: user.id },
        data: { phone: normalizedPhone, phoneVerified: false },
      });

      await writeAudit(tx, {
        action: "PHONE_CHANGED",
        targetType: "user",
        targetId: user.id,
        actor: { id: user.id, role: user.role, name: user.fullName },
        before: { phone: oldPhone },
        // `phoneVerified: false` belongs in the snapshot: the flag being reset
        // IS part of the change, and an audit row holding only the number would
        // hide that the new one is unproven (§6.1: stored with
        // phoneVerified = false until an SMS channel exists to prove it).
        after: { phone: normalizedPhone, phoneVerified: false },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
    });
  } catch (err) {
    // The read above narrows the race; `PatientProfile.phone`'s unique index
    // closes it — two sessions changing to the same number at once both pass
    // findUnique, and the second insert is where the database says no.
    if (isUniqueConstraintViolation(err)) {
      throw new AppError(409, "PHONE_ALREADY_EXISTS", "Phone number already registered");
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* §6.1 — account deletion (deactivate + anonymise, one transaction)   */
/* ------------------------------------------------------------------ */

export interface DeleteAccountInput extends RequestMeta {
  readonly userId: string;
  readonly password: string;
}

/** What §6.1 anonymisation replaces, and the pre-deletion snapshot the audit keeps. */
const ANONYMISED_NAME = "Deleted patient";

/**
 * §6.1's delete handler — the plan's four steps run in ONE transaction so a
 * guard failure can never leave a partially-deleted account:
 *
 * 1. **Release every live hold** (at most one: `seat_holds_one_live_hold_per_patient_unique`),
 *    decrementing `slot.heldCount` through the conditional `gte: 1` guard the
 *    §15/§17 paths use, and writing `releasedAt` + `DELETED_WITH_ACCOUNT`.
 *    Holds are released, never deleted, so the freed seat stays provable
 *    (§8.6).
 * 2. **Void each hold's pending payment order** — no money has moved for a
 *    hold, so nothing to refund and no gateway call (§6.1).
 * 3. **Only then the pending-money guards**: upcoming appointments, pending
 *    payments, pending refunds. Any throw here rolls back steps 1–2 with
 *    everything else — there is never a partial release or an orphaned hold.
 * 4. **Deactivate + anonymise + revoke every session** (§6.3), and audit the
 *    deletion with the before/after PII snapshot.
 *
 * The audit's `before` values — and the actor name — are read from the row
 * BEFORE step 4 rewrites it: a name snapshot taken after anonymisation would
 * record "Deleted patient" as who deleted the account, which is precisely the
 * attribution §5.1/§20 exist to make impossible to lose.
 *
 * Outstanding `AuthToken` rows are deliberately NOT consumed here: every
 * verification path (verifyEmail, verifyEmailChange, resetPassword) rejects a
 * deactivated account first, so the rows are inert history — consuming them
 * would be one more write with no security effect.
 *
 * The password check runs before the transaction, outside it: bcrypt's ~100ms
 * must not hold a connection open, and a wrong password should cost nothing
 * beyond the attempt log.
 */
export async function deleteAccount(input: DeleteAccountInput): Promise<void> {
  const ipKey = input.ip ?? UNKNOWN_IP_KEY;

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { patientProfile: true },
  });

  if (!user || !user.patientProfile) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  await assertCurrentPasswordMatches(user, input.password, ipKey);

  const now = new Date();
  const anonymisedPhone = `deleted-${user.id}`;

  // Captured before the transaction touches the row — see the doc comment.
  const actor = { id: user.id, role: user.role, name: user.fullName };
  const piiBefore = {
    fullName: user.fullName,
    email: user.email,
    phone: user.patientProfile.phone,
  };
  const auditMeta = { ip: input.ip ?? null, requestId: input.requestId ?? null };
  const deletionReason = "Patient deleted their own account";

  await prisma.$transaction(async (tx) => {
    /* (1) release live holds — §8.6: one per patient at most, by index. */
    const liveHolds = await tx.seatHold.findMany({
      where: { patientId: user.id, releasedAt: null },
    });

    for (const hold of liveHolds) {
      // The conditional guard, not a blind decrement: the counter only moves
      // while it has a seat to give back, which is how §15/§17 keep `heldCount`
      // from going negative if it ever disagrees with the rows. A zero here
      // means the counter already treats this seat as free — the release below
      // still runs, because `heldCount` is a LOWER bound on live holds
      // (schema.prisma: Slot), never the authority.
      await tx.slot.updateMany({
        where: { id: hold.slotId, heldCount: { gte: 1 } },
        data: { heldCount: { decrement: 1 } },
      });

      const released = await tx.seatHold.updateMany({
        where: { id: hold.id, releasedAt: null },
        data: { releasedAt: now, releaseReason: $Enums.SeatHoldReleaseReason.DELETED_WITH_ACCOUNT },
      });

      if (released.count === 1) {
        await writeAudit(tx, {
          action: "SEAT_HOLD_RELEASED",
          targetType: "seat_hold",
          targetId: hold.id,
          actor,
          after: { releasedAt: now.toISOString(), releaseReason: "DELETED_WITH_ACCOUNT" },
          reason: deletionReason,
          ...auditMeta,
        });
      }

      /* (2) void the hold's pending order — no money has moved (§6.1). */
      if (hold.paymentOrderId !== null) {
        const order = await tx.payment.findUnique({
          where: { orderId: hold.paymentOrderId },
          select: { id: true },
        });

        if (order) {
          const voided = await tx.payment.updateMany({
            where: { id: order.id, status: $Enums.PaymentStatus.PENDING },
            data: { status: $Enums.PaymentStatus.VOIDED },
          });

          if (voided.count === 1) {
            await writeAudit(tx, {
              action: "PAYMENT_ORDER_VOIDED",
              targetType: "payment",
              targetId: order.id,
              actor,
              after: { status: "VOIDED" },
              reason: deletionReason,
              ...auditMeta,
            });
          }
        }
      }
    }

    /* (3) guards — AFTER release/void, INSIDE the transaction (§6.1). */

    const upcoming = await tx.appointment.findFirst({
      where: {
        patientId: user.id,
        status: { in: [$Enums.AppointmentStatus.CONFIRMED, $Enums.AppointmentStatus.ARRIVED] },
        slot: { endAt: { gt: now } },
      },
      select: { id: true },
    });
    if (upcoming) {
      throw new AppError(
        409,
        "UPCOMING_APPOINTMENTS",
        "You have upcoming appointments. Cancel them before deleting your account.",
      );
    }

    // The hold's own order was voided two steps ago, so what this finds — if
    // anything — is money still genuinely in flight for an appointment.
    const pendingPayment = await tx.payment.findFirst({
      where: { patientId: user.id, status: $Enums.PaymentStatus.PENDING },
      select: { id: true },
    });
    if (pendingPayment) {
      throw new AppError(
        409,
        "PENDING_PAYMENT",
        "You have a payment still in progress. Resolve it before deleting your account.",
      );
    }

    const pendingRefund = await tx.refund.findFirst({
      where: { status: $Enums.RefundStatus.PENDING, payment: { patientId: user.id } },
      select: { id: true },
    });
    if (pendingRefund) {
      throw new AppError(
        409,
        "PENDING_REFUND",
        "You have a refund still in progress. It must finish before your account can be deleted.",
      );
    }

    /* (4) deactivate + anonymise + revoke (§5.1 mechanics, §6.1 target). */

    await tx.user.update({
      where: { id: user.id },
      data: {
        isDeactivated: true,
        // email is nullable-unique, so NULL vacates the address for reuse and
        // PostgreSQL's unique index ignores it — no two deleted patients can
        // collide on "no email". emailVerifiedAt goes with it: it describes an
        // address that no longer exists.
        email: null,
        pendingEmail: null,
        emailVerifiedAt: null,
        // Login is already refused by `isDeactivated` everywhere it is checked;
        // nulling the hash removes the credential itself, matching what a
        // provisioned-but-unclaimed account looks like (schema.prisma: User).
        passwordHash: null,
        fullName: ANONYMISED_NAME,
      },
    });

    await tx.patientProfile.update({
      where: { userId: user.id },
      data: {
        // The phone column is NOT NULL unique text with no CHECK: `deleted-<id>`
        // is unguessably unique per patient (the id is), reads as what it is to
        // anyone inspecting the row, cannot collide with a real E.164 number,
        // and cannot be re-registered — normalizePhoneToE164 rejects the shape
        // before uniqueness is ever consulted. NULL would be simpler but breaks
        // the constraint; a fabricated number could belong to a real person.
        phone: anonymisedPhone,
        phoneVerified: false,
      },
    });

    await revokeAllSessions(tx, user.id);

    await writeAudit(tx, {
      action: "PATIENT_ACCOUNT_DELETED",
      targetType: "user",
      targetId: user.id,
      actor,
      before: piiBefore,
      after: {
        fullName: ANONYMISED_NAME,
        email: null,
        phone: anonymisedPhone,
        isDeactivated: true,
      },
      reason: deletionReason,
      ...auditMeta,
    });
  });
}
