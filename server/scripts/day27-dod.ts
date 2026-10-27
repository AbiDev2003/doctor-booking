// Day 27 DoD against the real local database:
//
//   npx tsx scripts/day27-dod.ts
//
// Proves the §18 notification service end to end, WITHOUT a Resend key:
//
//   A. Registration queues one PENDING ACCOUNT_EMAIL_VERIFICATION row; dispatch
//      sends it through the injected FakeMailer and moves the row to SENT with
//      sentAt set.
//   B. A provider failure moves the row to FAILED with the provider error
//      visible; a later retry can still succeed and clears the error.
//   C. A re-dispatch of a SENT row does not send a second email.
//   D. Password reset request (LINK and OTP) produces the right template, and
//      reset completion queues ACCOUNT_PASSWORD_RESET_COMPLETED.
//   E. Email change queues ACCOUNT_EMAIL_CHANGE_VERIFICATION to the NEW address.
//   F. A doctor invitation queues ACCOUNT_INVITATION and carries the claim link.
//   G. Account deletion queues ACCOUNT_DEACTIVATED to the pre-deletion address
//      snapshot even though the user row is anonymised in the same transaction.
//   H. An ADMIN revoke-all-sessions action revokes every live token, audits it,
//      and queues the security notice; a second call sends no second notice.
//   I. Credential query parameters are redacted from request-log URLs.
//
// Clean-up removes every fixture this run creates (users, profiles, tokens,
// histories, audit rows, auth attempts and notifications) in a `finally`.

import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { $Enums, PrismaClient } from "../src/generated/prisma/client.js";
import type { Mailer, MailMessage } from "../src/lib/mailer.js";
import { sanitizeRequestUrl } from "../src/lib/logger.js";
import { generateToken, hashToken } from "../src/lib/auth.js";
import {
  accountDeactivatedEmail,
  accountInvitationEmail,
  allSessionsRevokedEmail,
  emailChangeVerificationEmail,
  emailVerificationEmail,
  passwordResetCompletedEmail,
  passwordResetEmail,
} from "../src/lib/emailTemplates.js";
import {
  registerPatient,
  forgotPassword,
  resetPassword,
  revokeUserSessions,
} from "../src/services/auth/auth.service.js";
import { changeEmail, deleteAccount } from "../src/services/account.service.js";
import { inviteDoctor } from "../src/services/doctor.service.js";
import type { ActorContext } from "../src/services/doctor.service.js";
import { dispatchNotification, queueNotification } from "../src/services/notifications/notification.service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

const FIXTURE_EMAIL_PREFIX = "day27-";
const FIXTURE_IP = "203.0.113.27";
const ORIGINAL_PASSWORD = "Day27-Original-Password-1";
const NEW_PASSWORD = "Day27-New-Password-1";

class FakeMailer implements Mailer {
  readonly messages: MailMessage[] = [];

  private readonly shouldFail: boolean;

  constructor(shouldFail = false) {
    this.shouldFail = shouldFail;
  }

  async send(message: MailMessage): Promise<{ readonly id: string }> {
    if (this.shouldFail) {
      throw new Error("fake mailer declined the message");
    }
    this.messages.push(message);
    return { id: `fake_${this.messages.length}` };
  }
}

function fail(message: string): never {
  throw new Error(`FAIL: ${message}`);
}

function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

interface RunState {
  readonly userIds: string[];
  readonly notificationIds: string[];
  readonly emails: string[];
}

async function removeFixtures(state: RunState): Promise<void> {
  if (state.userIds.length === 0) return;

  await prisma.notification.deleteMany({
    where: {
      OR: [
        { id: { in: state.notificationIds } },
        { recipient: { startsWith: FIXTURE_EMAIL_PREFIX } },
      ],
    },
  });
  await prisma.doctorHistory.deleteMany({
    where: {
      OR: [{ doctorId: { in: state.userIds } }, { actorId: { in: state.userIds } }],
    },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [{ targetId: { in: state.userIds } }, { actorId: { in: state.userIds } }],
    },
  });
  await prisma.authAttempt.deleteMany({
    where: {
      OR: [
        { ipKey: FIXTURE_IP },
        ...(state.emails.length > 0 ? [{ identifierKey: { in: state.emails } }] : []),
      ],
    },
  });
  await prisma.authToken.deleteMany({ where: { userId: { in: state.userIds } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: state.userIds } } });
  await prisma.patientProfile.deleteMany({ where: { userId: { in: state.userIds } } });
  await prisma.doctorProfile.deleteMany({ where: { userId: { in: state.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: state.userIds } } });
}

async function purgeStaleFixtures(): Promise<number> {
  const stale = await prisma.user.findMany({
    where: { email: { startsWith: FIXTURE_EMAIL_PREFIX } },
    select: { id: true, email: true },
  });

  if (stale.length === 0) return 0;

  await removeFixtures({
    userIds: stale.map((row) => row.id),
    notificationIds: [],
    emails: stale.flatMap((row) => (row.email === null ? [] : [row.email])),
  });
  return stale.length;
}

async function notificationRow(id: string) {
  return prisma.notification.findUnique({
    where: { id },
    select: { type: true, recipient: true, status: true, sentAt: true, error: true },
  });
}

async function main(): Promise<void> {
  const purged = await purgeStaleFixtures();
  if (purged > 0) console.log(`Purged ${purged} stale ${FIXTURE_EMAIL_PREFIX}* fixtures.`);

  const suffix = Date.now().toString().slice(-8);
  const email = `${FIXTURE_EMAIL_PREFIX}patient-${suffix}@example.test`;
  const newEmail = `${FIXTURE_EMAIL_PREFIX}changed-${suffix}@example.test`;
  const doctorEmail = `${FIXTURE_EMAIL_PREFIX}doctor-${suffix}@example.test`;
  const phone = `+9199${suffix}`;

  const state: RunState = { userIds: [], notificationIds: [], emails: [email, newEmail, doctorEmail] };

  try {
    /* A. Registration → verification email, PENDING → SENT. */
    const registered = await registerPatient({
      email,
      password: ORIGINAL_PASSWORD,
      fullName: "Day 27 Patient",
      phone,
      ip: FIXTURE_IP,
    });
    state.userIds.push(registered.userId);
    state.notificationIds.push(registered.notificationId);

    const queued = await notificationRow(registered.notificationId);
    if (queued === null) fail("registration did not write a notification row");
    expect(queued.type === $Enums.NotificationType.ACCOUNT_EMAIL_VERIFICATION, "wrong registration notification type");
    expect(queued.status === $Enums.NotificationStatus.PENDING, "registration notification should start PENDING");
    expect(queued.sentAt === null, "a PENDING row must not have sentAt");

    const verificationMailer = new FakeMailer();
    await dispatchNotification(
      registered.notificationId,
      emailVerificationEmail({
        fullName: "Day 27 Patient",
        link: `http://localhost:5173/verify-email?token=${registered.rawToken}`,
        expiresIn: "15 minutes",
      }),
      { mailer: verificationMailer },
    );

    const sent = await notificationRow(registered.notificationId);
    if (sent === null) fail("verification notification row disappeared");
    expect(sent.status === $Enums.NotificationStatus.SENT, "verification email did not reach SENT");
    expect(sent.sentAt instanceof Date, "SENT row is missing sentAt");
    expect(verificationMailer.messages.length === 1, "verification email was not sent exactly once");
    expect(verificationMailer.messages[0]?.to === email, "verification email went to the wrong recipient");
    expect(verificationMailer.messages[0]?.text.includes(registered.rawToken) === true, "verification email lost the link token");
    console.log("A. Registration queues and sends one verification email; the row becomes SENT.");

    /* C. A SENT row is not sent twice. */
    const repeatMailer = new FakeMailer();
    await dispatchNotification(
      registered.notificationId,
      emailVerificationEmail({ fullName: "Day 27 Patient", link: "unused", expiresIn: "15 minutes" }),
      { mailer: repeatMailer },
    );
    expect(repeatMailer.messages.length === 0, "a SENT notification was dispatched again");
    console.log("C. Re-dispatching a SENT notification is a no-op.");

    /* B. Provider failure → FAILED, then a retry succeeds. */
    const failingRow = await queueNotification(prisma, {
      type: $Enums.NotificationType.ACCOUNT_EMAIL_VERIFICATION,
      recipient: email,
    });
    state.notificationIds.push(failingRow.id);

    await dispatchNotification(
      failingRow.id,
      emailVerificationEmail({ fullName: "Day 27 Patient", link: "http://localhost:5173/verify-email?token=x", expiresIn: "15 minutes" }),
      { mailer: new FakeMailer(true) },
    );

    const failed = await notificationRow(failingRow.id);
    if (failed === null) fail("failed notification row disappeared");
    expect(failed.status === $Enums.NotificationStatus.FAILED, "a rejected send did not become FAILED");
    expect(failed.error?.includes("declined") === true, "FAILED row does not expose the provider error");
    expect(failed.sentAt === null, "FAILED row must not have sentAt");

    const retryMailer = new FakeMailer();
    await dispatchNotification(
      failingRow.id,
      emailVerificationEmail({ fullName: "Day 27 Patient", link: "http://localhost:5173/verify-email?token=x", expiresIn: "15 minutes" }),
      { mailer: retryMailer },
    );
    const retried = await notificationRow(failingRow.id);
    if (retried === null) fail("retried notification row disappeared");
    expect(retried.status === $Enums.NotificationStatus.SENT, "retrying a FAILED send did not reach SENT");
    expect(retried.error === null, "a successful retry did not clear the old error");
    console.log("B. A failed send is visible as FAILED and can be retried to SENT.");

    /* D. Password reset request: LINK, then OTP; completion notice. */
    const linkReset = await forgotPassword({ email, method: "LINK", ip: FIXTURE_IP });
    if (!linkReset.sent) fail("password reset request for a real account was skipped");
    state.notificationIds.push(linkReset.notificationId);

    const linkMailer = new FakeMailer();
    await dispatchNotification(
      linkReset.notificationId,
      passwordResetEmail({
        fullName: linkReset.fullName,
        method: "LINK",
        link: `http://localhost:5173/reset-password?token=${linkReset.rawToken}`,
        expiresIn: "15m",
      }),
      { mailer: linkMailer },
    );
    expect(linkMailer.messages[0]?.text.includes(linkReset.rawToken) === true, "LINK reset email lost the token");
    expect(linkMailer.messages[0]?.subject.toLowerCase().includes("reset") === true, "LINK reset subject is wrong");

    const otpReset = await forgotPassword({ email, method: "OTP", ip: FIXTURE_IP });
    if (!otpReset.sent) fail("second password reset request was skipped");
    state.notificationIds.push(otpReset.notificationId);

    const otpMailer = new FakeMailer();
    await dispatchNotification(
      otpReset.notificationId,
      passwordResetEmail({
        fullName: otpReset.fullName,
        method: "OTP",
        otp: otpReset.rawToken,
        expiresIn: "15m",
      }),
      { mailer: otpMailer },
    );
    expect(otpMailer.messages[0]?.text.includes(otpReset.rawToken) === true, "OTP reset email lost the code");

    const reset = await resetPassword({
      token: otpReset.rawToken,
      password: NEW_PASSWORD,
      ip: FIXTURE_IP,
      requestId: "day27-dod",
    });
    expect(reset.notificationId !== null, "reset completion did not queue a notification");
    if (reset.notificationId !== null) state.notificationIds.push(reset.notificationId);

    const completedMailer = new FakeMailer();
    if (reset.notificationId !== null) {
      await dispatchNotification(
        reset.notificationId,
        passwordResetCompletedEmail({ fullName: reset.fullName }),
        { mailer: completedMailer },
      );
    }
    expect(completedMailer.messages.length === 1, "reset completion email was not sent");
    expect(completedMailer.messages[0]?.subject.toLowerCase().includes("changed") === true, "reset completion subject is wrong");
    console.log("D. LINK + OTP reset requests send; reset completion queues and sends its notice.");

    /* E. Email change goes to the NEW address. */
    const changed = await changeEmail({
      userId: registered.userId,
      email: newEmail,
      ip: FIXTURE_IP,
      requestId: "day27-dod",
    });
    state.notificationIds.push(changed.notificationId);

    const changeMailer = new FakeMailer();
    await dispatchNotification(
      changed.notificationId,
      emailChangeVerificationEmail({
        fullName: "Day 27 Patient",
        link: `http://localhost:5173/verify-email-change?token=${changed.rawToken}`,
        expiresIn: "15m",
      }),
      { mailer: changeMailer },
    );
    expect(changeMailer.messages[0]?.to === newEmail, "email-change verification did not go to the new address");
    expect(changeMailer.messages[0]?.text.includes(changed.rawToken) === true, "email-change email lost the token");
    console.log("E. Email change queues a verification to the new address only.");

    /* F. Doctor invitation. */
    const actor: ActorContext = { id: registered.userId, role: $Enums.UserRole.ADMIN, name: "Day 27 DoD" };
    const invite = await inviteDoctor({
      actor,
      email: doctorEmail,
      fullName: "Day 27 Doctor",
      ip: FIXTURE_IP,
      requestId: "day27-dod",
    });
    state.userIds.push(invite.userId);
    state.notificationIds.push(invite.notificationId);

    const inviteMailer = new FakeMailer();
    await dispatchNotification(
      invite.notificationId,
      accountInvitationEmail({
        fullName: "Day 27 Doctor",
        link: `http://localhost:5173/claim-account?token=${invite.rawToken}`,
        roleLabel: "doctor",
        expiresIn: "24h",
      }),
      { mailer: inviteMailer },
    );
    expect(inviteMailer.messages[0]?.to === doctorEmail, "invitation went to the wrong address");
    expect(inviteMailer.messages[0]?.text.includes(invite.rawToken) === true, "invitation lost the claim token");
    expect(inviteMailer.messages[0]?.subject.toLowerCase().includes("invited") === true, "invitation subject is wrong");
    console.log("F. Doctor invitation queues and sends the claim link.");

    /* G. Deletion snapshots the address BEFORE anonymisation. */
    const deleted = await deleteAccount({
      userId: registered.userId,
      password: NEW_PASSWORD,
      ip: FIXTURE_IP,
      requestId: "day27-dod",
    });
    expect(deleted.notificationId !== null, "account deletion did not queue a confirmation");
    if (deleted.notificationId !== null) state.notificationIds.push(deleted.notificationId);

    const deletionRow = deleted.notificationId === null ? null : await notificationRow(deleted.notificationId);
    expect(deletionRow?.recipient === email, "deletion notification did not snapshot the pre-deletion email");
    expect(deletionRow?.type === $Enums.NotificationType.ACCOUNT_DEACTIVATED, "wrong deletion notification type");

    const deletedMailer = new FakeMailer();
    if (deleted.notificationId !== null) {
      await dispatchNotification(
        deleted.notificationId,
        accountDeactivatedEmail({ fullName: "Day 27 Patient" }),
        { mailer: deletedMailer },
      );
    }
    expect(deletedMailer.messages[0]?.to === email, "deletion confirmation did not use the snapshot address");
    console.log("G. Deletion keeps the pre-anonymisation address on the notification row.");

    /* H. Admin revoke-all-sessions: live tokens, audit, one security notice. */
    const doctorSessions = await Promise.all(
      [1, 2].map(async () => {
        const rawToken = generateToken();
        return prisma.refreshToken.create({
          data: {
            userId: invite.userId,
            tokenHash: hashToken(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            ip: FIXTURE_IP,
          },
          select: { id: true },
        });
      }),
    );
    expect(doctorSessions.length === 2, "failed to create the doctor's live sessions");

    const securityReason = "Day 27 DoD session revocation";
    const revoked = await revokeUserSessions({
      actor: { id: registered.userId, role: $Enums.UserRole.ADMIN, name: "Day 27 DoD Admin" },
      userId: invite.userId,
      reason: securityReason,
      ip: FIXTURE_IP,
      requestId: "day27-dod",
    });
    expect(revoked.revokedCount === 2, "admin revocation did not revoke every live token");
    expect(revoked.notificationId !== null, "admin revocation did not queue a security notice");
    if (revoked.notificationId === null) fail("admin revocation did not queue a security notice");
    state.notificationIds.push(revoked.notificationId);

    const securityRow = await notificationRow(revoked.notificationId);
    expect(securityRow?.type === $Enums.NotificationType.ACCOUNT_ALL_SESSIONS_REVOKED, "wrong security notice type");
    expect(securityRow?.recipient === doctorEmail, "security notice went to the wrong address");
    expect(securityRow?.status === $Enums.NotificationStatus.PENDING, "security notice should start PENDING");

    const liveSessions = await prisma.refreshToken.count({
      where: { userId: invite.userId, revokedAt: null },
    });
    expect(liveSessions === 0, "admin revocation left a live refresh token");

    const revocationAudit = await prisma.auditLog.findFirst({
      where: { action: "USER_SESSIONS_REVOKED", targetId: invite.userId, reason: securityReason },
      select: { actorName: true, actorRole: true, before: true, after: true },
    });
    expect(revocationAudit?.actorName === "Day 27 DoD Admin", "revocation audit lost the actor name snapshot");
    expect(revocationAudit?.actorRole === $Enums.UserRole.ADMIN, "revocation audit lost the actor role");
    expect(
      JSON.stringify(revocationAudit?.before) === JSON.stringify({ activeSessions: 2 }),
      "revocation audit did not snapshot the live session count",
    );

    const securityMailer = new FakeMailer();
    await dispatchNotification(
      revoked.notificationId,
      allSessionsRevokedEmail({ fullName: revoked.fullName }),
      { mailer: securityMailer },
    );
    expect(securityMailer.messages[0]?.to === doctorEmail, "security notice did not reach the doctor");
    expect(securityMailer.messages[0]?.subject.toLowerCase().includes("security") === true, "security notice subject is wrong");
    expect((await notificationRow(revoked.notificationId))?.status === $Enums.NotificationStatus.SENT, "security notice did not send");

    const revokedAgain = await revokeUserSessions({
      actor: { id: registered.userId, role: $Enums.UserRole.ADMIN, name: "Day 27 DoD Admin" },
      userId: invite.userId,
      reason: "Repeated Day 27 DoD session revocation",
      ip: FIXTURE_IP,
      requestId: "day27-dod",
    });
    expect(revokedAgain.revokedCount === 0, "a repeated revoke claimed to revoke more sessions");
    expect(revokedAgain.notificationId === null, "a repeated revoke queued a second security notice");

    const noticeCount = await prisma.notification.count({
      where: {
        type: $Enums.NotificationType.ACCOUNT_ALL_SESSIONS_REVOKED,
        recipient: doctorEmail,
      },
    });
    expect(noticeCount === 1, "the doctor received more than one security notice");
    console.log("H. Admin revocation revokes every live token, audits it, and emails exactly once.");

    /* I. Credential query parameters never reach the request log. */
    const sanitized = sanitizeRequestUrl("/api/v1/auth/verify-email?token=live-secret&next=%2Fhome");
    expect(!sanitized.includes("live-secret"), "sanitizeRequestUrl leaked a token");
    expect(sanitized.includes("token=REDACTED"), "sanitizeRequestUrl did not mark the token");
    expect(sanitized.includes("next=%2Fhome"), "sanitizeRequestUrl damaged an unrelated parameter");
    console.log("I. Token/OTP query parameters are redacted from logged request URLs.");

    console.log("\nDay 27 DoD passed.");
  } finally {
    await removeFixtures(state);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
