import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accountDeactivatedEmail,
  accountInvitationEmail,
  allSessionsRevokedEmail,
  emailChangeVerificationEmail,
  emailVerificationEmail,
  passwordResetCompletedEmail,
  passwordResetEmail,
} from "../src/lib/emailTemplates.js";

const link = "https://clinic.example/verify-email?token=abc123";

describe("email verification template", () => {
  it("carries the link in both HTML and text", () => {
    const email = emailVerificationEmail({ fullName: "Asha Rao", link, expiresIn: "15 minutes" });
    assert.match(email.html, /verify-email\?token=abc123/);
    assert.match(email.text, /verify-email\?token=abc123/);
  });

  it("escapes a hostile display name instead of injecting markup", () => {
    const email = emailVerificationEmail({
      fullName: "<script>alert(1)</script>",
      link,
      expiresIn: "15 minutes",
    });
    assert.equal(email.html.includes("<script>"), false);
    assert.match(email.html, /&lt;script&gt;/);
  });
});

describe("password reset template", () => {
  it("shows a link for the LINK method", () => {
    const email = passwordResetEmail({ fullName: "Asha", method: "LINK", link, expiresIn: "15m" });
    assert.match(email.text, /Reset your password here/);
    assert.match(email.text, /abc123/);
  });

  it("shows the six-digit code for the OTP method and no link", () => {
    const email = passwordResetEmail({ fullName: "Asha", method: "OTP", otp: "012345", expiresIn: "15m" });
    assert.match(email.text, /012345/);
    assert.equal(email.html.includes("https://"), false);
  });
});

describe("account templates", () => {
  it("uses the explicit role label on an invitation", () => {
    const email = accountInvitationEmail({
      fullName: "Dr Rao",
      link: "https://clinic.example/claim-account?token=claim1",
      roleLabel: "doctor",
      expiresIn: "24h",
    });
    assert.match(email.text, /as a doctor/);
    assert.match(email.html, /claim-account\?token=claim1/);
  });

  it("warns the new address on an email change", () => {
    const email = emailChangeVerificationEmail({ fullName: "Asha", link, expiresIn: "15m" });
    assert.match(email.text, /current address stays active/);
  });

  it("states that the password changed", () => {
    const email = passwordResetCompletedEmail({ fullName: "Asha" });
    assert.match(email.subject.toLowerCase(), /password was changed/);
  });

  it("states that all sessions were signed out", () => {
    const email = allSessionsRevokedEmail({ fullName: "Asha" });
    assert.match(email.subject.toLowerCase(), /security notice/);
  });

  it("states that the account was deleted", () => {
    const email = accountDeactivatedEmail({ fullName: "Asha" });
    assert.match(email.subject.toLowerCase(), /account was deleted/);
  });
});
